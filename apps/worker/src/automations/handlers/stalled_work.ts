// Stalled Work handler — weekly deep sweep of dropped balls.
//
// Default schedule: Fridays 15:00 user-local (suggestedAutomation
// 'weekly-stalled'). Distinct from Brief Me's inline flagging of stalled
// items: this is the dedicated, longer-form sweep that takes a 30-day
// lookback and surfaces *everything* that has gone quiet.
//
// Window: now - 30d through now. The handler reasons about "stalled"
// using two signals from the activity-window payload:
//   - todos.activeNow where daysOpen >= 14
//   - todos.overdueNow
// Future signals (commitments in past transcripts that never produced a
// todo) are out of scope for v0.3.0 — they need transcript-level NLP that
// belongs in fan-out, not here.
//
// Output lands at:
//   slug:  automations/stalled/YYYY-MM-DD
//   title: "YYYY-MM-DD — <AI-picked semantic>"

import { getGeminiClient } from '@audri/shared/gemini';
import type { UsageMetadata } from '@google/genai';
import { logger } from '../../logger.js';
import { recordInferenceUsage } from '../../usage/record-inference.js';
import { type ActivityWindow, fetchActivityWindow } from '../activity-window.js';
import {
  commitAutomationPage,
  fetchUserTimezone,
  formatYmd,
  parseAutomationMarkdown,
} from '../commit.js';

export const STALLED_WORK_MODEL = 'gemini-3.1-pro-preview';

export interface StalledWorkHandlerCtx {
  userId: string;
  agentTaskId: string;
  agentId: string | null;
  payload: unknown;
}

export interface StalledWorkHandlerResult {
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  sectionsCreated: number;
}

const WINDOW_BACK_MS = 30 * 24 * 60 * 60 * 1000;

export async function stalledWorkHandler(
  ctx: StalledWorkHandlerCtx,
): Promise<StalledWorkHandlerResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_BACK_MS);
  const userTimezone = await fetchUserTimezone(ctx.userId);

  logger.info(
    { userId: ctx.userId, agentTaskId: ctx.agentTaskId },
    'stalled_work handler: starting',
  );

  const activity = await fetchActivityWindow({
    userId: ctx.userId,
    windowStart,
    windowEnd: now,
    timezone: userTimezone,
  });

  const { systemPrompt, userMessage } = buildStalledPrompt(activity);
  const { markdown, usage } = await callPro(systemPrompt, userMessage);

  void recordInferenceUsage({
    userId: ctx.userId,
    agentId: ctx.agentId ?? undefined,
    agentTaskId: ctx.agentTaskId,
    eventKind: 'ingestion', // usage_event_kind doesn't yet have 'automation'
    model: STALLED_WORK_MODEL,
    usage,
  });

  const parsed = parseAutomationMarkdown(markdown, 'Stalled work');
  if (parsed.sections.length === 0) {
    throw new Error('stalled_work handler: parsed 0 sections from Pro output');
  }

  const fireStamp = formatYmd(now, userTimezone);
  const result = await commitAutomationPage({
    userId: ctx.userId,
    agentTaskId: ctx.agentTaskId,
    subFolderSlug: 'stalled',
    subFolderTitle: 'Stalled work',
    subFolderAbstract:
      'Weekly sweeps of stalled todos and dropped follow-ups — balls that may have been dropped.',
    fireStamp,
    pageTitle: `${fireStamp} — ${parsed.title}`,
    pageAbstract: `Automation-generated stalled-work review. ${fireStamp}.`,
    sections: parsed.sections,
    sourceCalls: activity.calls,
  });

  logger.info(
    {
      userId: ctx.userId,
      agentTaskId: ctx.agentTaskId,
      pageSlug: result.pageSlug,
      sectionsCreated: result.sectionsCreated,
    },
    'stalled_work handler: complete',
  );

  return result;
}

// ── Prompt ───────────────────────────────────────────────────────────────

const STALLED_WORK_SYSTEM_PROMPT = `You are surfacing the user's stalled work — todos that have gone quiet, follow-ups that never landed, commitments that may have been dropped. The goal is honest visibility, not pressure.

# Voice

- Second person, calm, observational. "This has been sitting for three weeks" not "You have been ignoring this for three weeks." Surface, don't accuse.
- Curious and helpful. The user already feels enough guilt about dropped balls; you are not here to add to it. You are here to make the pile visible so they can decide what to do.
- No urgency theater. Don't manufacture deadlines. Don't say "this is critical" unless the user previously said it was critical.
- Direct about the data. If something has been stalled for 23 days, say "23 days", not "a while". Specific is kind.
- When you can suggest a small next step that would unstick something, offer it — one sentence, take-it-or-leave-it. When you can't, just name the item and stop.

# What counts as stalled

Apply judgment, but the general thresholds in the activity payload:
- An **active todo** with daysOpen >= 14 is a candidate. Older = stronger candidate.
- An **overdue todo** is always a candidate, regardless of daysOpen.
- A **research task** pending for >7 days is a candidate.
- **Reminders** are NOT stalled (they're recurring by design — skip them unless one was meant to be acted-on, not just reminded-about).
- **Completed work** is irrelevant — this page is about what HASN'T happened.

# Structure

- Single markdown page.
- One H1 (# Title). The title should set the size of the pile honestly. "A handful to revisit" for a light week; "More dropped than usual" for a heavier one; "Mostly clear, three to triage" when there's actually little. Specific, not generic.
- 2–4 H2 (## Section name) sections, grouped by **project or theme** — NOT by data type. If you have stalled todos about the Consensus pitch AND stalled todos about the move, those are two sections, not one "Stalled todos" section.
- If items don't cluster naturally, one section called "Loose ends" is acceptable for the leftovers.
- Within each section, present items as a brief intro paragraph (1–2 sentences) + a tight list. Each list item: the item itself, the duration it has been stalled, and optionally a one-sentence "you could do X" suggestion. Example shape:
    - **Sketch Q2 hiring plan** — 19 days open. The conversation last week implied this was waiting on the funding update, which has now landed.
- Hard cap: **12 items total** across all sections. If there are more candidates than that, pick the highest-signal ones (older, overdue, or referenced in recent calls). Don't exhaustively list — that's noise, not signal.

# Length

~300–600 words. Aim for the middle. A short pile honestly described is more useful than a long one.

# Format requirements

- Output ONLY the markdown page body — no preamble, no "Here is your weekly review:".
- Start with a single H1 line.
- Use H2 (## Section name) for each section.
- Use bold (\`**item**\`) for the item itself within bulleted lists. Plain prose for intros.

# Never

- NEVER fabricate items, durations, or context. If a todo's title doesn't say what it's about, surface the title as-is — don't invent purpose.
- NEVER moralize. "You should really get to this" is wrong. "This has been sitting for 21 days" is right.
- NEVER repeat the same item across sections. Each item appears once.
- NEVER include completed items, finished research, or anything that has already moved.
- NEVER end with a motivational close or a summary sentence. The last item is the last sentence.
- NEVER use [[slug]] cross-reference syntax — the renderer doesn't resolve it yet. Reference pages by name.
- NEVER list more than 12 items total. Choose well.`;

function buildStalledPrompt(activity: ActivityWindow): {
  systemPrompt: string;
  userMessage: string;
} {
  const userMessage = `# Window
This review looks at the past 30 days: ${activity.windowStart} through ${activity.windowEnd} (timezone: ${activity.userTimezone}). "Stalled" thresholds: active todos with daysOpen >= 14, all overdue todos, pending research >7 days old.

# Activity
${JSON.stringify(
  {
    calls: activity.calls,
    todos: activity.todos,
    research: activity.research,
    notesActivity: activity.notesActivity,
  },
  null,
  2,
)}

# Output
Write the review. Output ONLY the markdown page body — no preamble. Start with the H1 title line. Hard cap: 12 items across all sections.`;

  return { systemPrompt: STALLED_WORK_SYSTEM_PROMPT, userMessage };
}

// ── Pro call ─────────────────────────────────────────────────────────────

async function callPro(
  systemPrompt: string,
  userMessage: string,
): Promise<{ markdown: string; usage: UsageMetadata | undefined }> {
  const resp = await getGeminiClient().models.generateContent({
    model: STALLED_WORK_MODEL,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      temperature: 0.4,
    },
  });
  const markdown = resp.text?.trim();
  if (!markdown) {
    throw new Error(
      `stalled_work handler: Pro returned empty response (finishReason=${resp.candidates?.[0]?.finishReason})`,
    );
  }
  return { markdown, usage: resp.usageMetadata };
}
