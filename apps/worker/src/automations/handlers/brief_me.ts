// Brief Me handler — forward-looking "what's on your plate" synthesis.
//
// Default schedule: 07:00 user-local each morning (suggestedAutomation
// 'morning-brief'). Distinct from recap (backward) and from stalled_work
// (deep weekly sweep). This is the daily one-glance "here's today" page.
//
// Window: now - 24h (yesterday's tail for context) through now + 24h
// (today's incoming work + tomorrow's first edge). The forward span is
// what makes this kind useful — the prompt is explicit about not
// rehashing yesterday in detail (the recap handles that).
//
// Output lands at:
//   slug:  automations/briefs/YYYY-MM-DD
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

export const BRIEF_ME_MODEL = 'gemini-3.1-pro-preview';

export interface BriefMeHandlerCtx {
  userId: string;
  agentTaskId: string;
  agentId: string | null;
  payload: unknown;
}

export interface BriefMeHandlerResult {
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  sectionsCreated: number;
}

const WINDOW_BACK_MS = 24 * 60 * 60 * 1000;
const WINDOW_FORWARD_MS = 24 * 60 * 60 * 1000;

export async function briefMeHandler(ctx: BriefMeHandlerCtx): Promise<BriefMeHandlerResult> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_BACK_MS);
  const windowEnd = new Date(now.getTime() + WINDOW_FORWARD_MS);
  const userTimezone = await fetchUserTimezone(ctx.userId);

  logger.info(
    { userId: ctx.userId, agentTaskId: ctx.agentTaskId },
    'brief_me handler: starting',
  );

  // Brief consumes most slices, but the prompt emphasises forward-looking
  // signals (active/overdue todos, today's reminders) over backward ones
  // (completed work, finished research). Activity-window slice limits
  // already bound the payload — let the prompt cull the noise.
  const activity = await fetchActivityWindow({
    userId: ctx.userId,
    windowStart,
    windowEnd,
    timezone: userTimezone,
  });

  const { systemPrompt, userMessage } = buildBriefMePrompt(activity);
  const { markdown, usage } = await callPro(systemPrompt, userMessage);

  void recordInferenceUsage({
    userId: ctx.userId,
    agentId: ctx.agentId ?? undefined,
    agentTaskId: ctx.agentTaskId,
    eventKind: 'ingestion', // usage_event_kind doesn't yet have 'automation'
    model: BRIEF_ME_MODEL,
    usage,
  });

  const parsed = parseAutomationMarkdown(markdown, 'Brief');
  if (parsed.sections.length === 0) {
    throw new Error('brief_me handler: parsed 0 sections from Pro output');
  }

  const fireStamp = formatYmd(now, userTimezone);
  const result = await commitAutomationPage({
    userId: ctx.userId,
    agentTaskId: ctx.agentTaskId,
    subFolderSlug: 'briefs',
    subFolderTitle: 'Briefs',
    subFolderAbstract:
      'Daily forward-looking briefs — what is on your plate today.',
    fireStamp,
    pageTitle: `${fireStamp} — ${parsed.title}`,
    pageAbstract: `Automation-generated morning brief. ${fireStamp}.`,
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
    'brief_me handler: complete',
  );

  return result;
}

// ── Prompt ───────────────────────────────────────────────────────────────

const BRIEF_ME_SYSTEM_PROMPT = `You are writing a forward-looking brief for the user — what is on their plate today, plus the things from recent activity that they should know about heading into the day.

This is NOT a recap. Don't dwell on what already happened — the recap handler covers that. This page exists so the user can read it once over their morning coffee and feel oriented for the day. If they only read one section, they should know where their attention belongs.

# Voice

- Second person, calibrated, direct. "You have three todos due today" not "There are three todos." Speak to them, not about them.
- Practical. Not motivational. No "Have a great day!" or "You've got this!". The user is an adult; they don't need cheerleading.
- Brisk. This is a glance, not an essay. Sentences earn their place.
- When something is uncertain (a todo without a clear next step, a stale reminder, a research task with no result yet), say so. Don't paper over it.
- Honor the user's own framing. If they called something "the bottleneck", call it that — not "the issue you mentioned".

# What to include

Default to ~2–3 sections from this menu, in roughly this order of priority:

- **On deck today.** Active todos due today, reminders firing today, calls/research where the user is the next mover. The thing they actually need to do.
- **Worth a look.** Items that aren't time-sensitive today but are worth surfacing: recently completed research outputs the user hasn't reviewed, follow-ups from yesterday's calls, in-progress todos that haven't moved in a while. Inline-flag these — don't pad a separate section for them if there's nothing there.
- **Carrying forward.** Overdue items + commitments the user made in recent conversations that haven't translated into todos. Be tactful: name the item, not the lapse.

If a section has nothing meaningful in it, omit it. Three sparse sections is worse than one substantive one.

# Structure

- Single markdown page.
- One H1 (# Title) — a specific, evocative title for the day's brief (not "Daily brief" or "Morning briefing"). If the day is unusually full, name that. If it's quiet, name that. The title is the elevator pitch.
- One H2 (## Section name) per section. Section names should be specific or borrow phrasing from the user's recent activity, not the generic menu names above.
- Within sections, mix short prose + tight bullets. Bullets when items are list-shaped (todos, reminders); prose when context is needed.
- For each surfaced item, give just enough context that the user knows why it's surfaced — usually a half-sentence. Don't restate what they already know about it.

# Length

~200–400 words. Aim for the lower end. A quiet day with two todos and no reminders is a 100-word page; don't pad. A heavy day deserves the upper bound.

# Format requirements

- Output ONLY the markdown page body — no preamble, no "Here is your brief:".
- Start with a single H1 line.
- Use H2 (## Section name) for each section.

# Never

- NEVER fabricate items, due dates, or commitments. If the activity payload has no overdue todos, don't write a "carrying forward" section listing imaginary ones.
- NEVER end with a motivational close. The last sentence of the brief is the last item, not a sendoff.
- NEVER summarize what got done yesterday in detail — at most one sentence of context, and only if it bears on today.
- NEVER list every todo. Be selective: surface the ones that matter today, group or omit the rest.
- NEVER include explicit timestamps in body text (the page metadata carries the fire time).
- NEVER use [[slug]] cross-reference syntax — the renderer doesn't resolve it yet. Reference pages and items by name.
- NEVER mention "based on the activity data" or otherwise reveal the source mechanism. Write as if you've simply been watching.`;

function buildBriefMePrompt(activity: ActivityWindow): {
  systemPrompt: string;
  userMessage: string;
} {
  const userMessage = `# Window
This brief covers the period from ${activity.windowStart} (yesterday) through ${activity.windowEnd} (tomorrow's first edge). Center on TODAY in the user's timezone (${activity.userTimezone}).

# Activity
${JSON.stringify(
  {
    calls: activity.calls,
    notesActivity: activity.notesActivity,
    todos: activity.todos,
    research: activity.research,
    remindersDueInWindow: activity.remindersDueInWindow,
    dreams: activity.dreams,
  },
  null,
  2,
)}

# Output
Write the brief. Output ONLY the markdown page body — no preamble. Start with the H1 title line.`;

  return { systemPrompt: BRIEF_ME_SYSTEM_PROMPT, userMessage };
}

// ── Pro call ─────────────────────────────────────────────────────────────

async function callPro(
  systemPrompt: string,
  userMessage: string,
): Promise<{ markdown: string; usage: UsageMetadata | undefined }> {
  const resp = await getGeminiClient().models.generateContent({
    model: BRIEF_ME_MODEL,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      temperature: 0.4, // tighter than recap — facts more than vibe
    },
  });
  const markdown = resp.text?.trim();
  if (!markdown) {
    throw new Error(
      `brief_me handler: Pro returned empty response (finishReason=${resp.candidates?.[0]?.finishReason})`,
    );
  }
  return { markdown, usage: resp.usageMetadata };
}
