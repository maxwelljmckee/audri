// Recap handler — daily / weekly variants.
//
// Path: dispatch-agent-task.ts invokes this when an agent_task with
// kind='recap' is dequeued. Flow:
//   1. Determine variant (daily | weekly) from payload + compute window
//   2. Fetch activity-window snapshot
//   3. Call Pro with the recap prompt
//   4. Parse markdown output into title + sections
//   5. Commit via shared commitAutomationPage helper
//   6. Record usage_events
//
// Output lands at:
//   slug:  automations/recaps/YYYY-MM-DD       (daily)
//   slug:  automations/recaps/YYYY-WKNN        (weekly — ISO week)
//   title: "YYYY-MM-DD — <AI-picked semantic>"

import { getGeminiClient } from '@audri/shared/gemini';
import type { UsageMetadata } from '@google/genai';
import { logger } from '../../logger.js';
import { recordInferenceUsage } from '../../usage/record-inference.js';
import { type ActivityWindow, fetchActivityWindow } from '../activity-window.js';
import {
  commitAutomationPage,
  fetchUserTimezone,
  formatIsoWeek,
  formatYmd,
  parseAutomationMarkdown,
} from '../commit.js';

export const RECAP_MODEL = 'gemini-3.1-pro-preview';
const RECAP_VARIANTS = ['daily', 'weekly'] as const;
type RecapVariant = (typeof RECAP_VARIANTS)[number];

export interface RecapPayload {
  variant?: RecapVariant;
}

export interface RecapHandlerCtx {
  userId: string;
  agentTaskId: string;
  agentId: string | null;
  payload: unknown;
}

export interface RecapHandlerResult {
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  sectionsCreated: number;
  variant: RecapVariant;
}

export async function recapHandler(ctx: RecapHandlerCtx): Promise<RecapHandlerResult> {
  const variant = parseVariant(ctx.payload);
  const now = new Date();
  const windowStart = computeWindowStart(now, variant);
  const userTimezone = await fetchUserTimezone(ctx.userId);

  logger.info(
    { userId: ctx.userId, agentTaskId: ctx.agentTaskId, variant },
    'recap handler: starting',
  );

  const activity = await fetchActivityWindow({
    userId: ctx.userId,
    windowStart,
    windowEnd: now,
    timezone: userTimezone,
  });

  const { systemPrompt, userMessage } = buildRecapPrompt(variant, activity);
  const { markdown, usage } = await callPro(systemPrompt, userMessage);

  void recordInferenceUsage({
    userId: ctx.userId,
    agentId: ctx.agentId ?? undefined,
    agentTaskId: ctx.agentTaskId,
    eventKind: 'ingestion', // usage_event_kind doesn't yet have 'automation'
    model: RECAP_MODEL,
    usage,
  });

  const parsed = parseAutomationMarkdown(markdown, 'Recap');
  if (parsed.sections.length === 0) {
    throw new Error('recap handler: parsed 0 sections from Pro output');
  }

  const fireStamp = variant === 'daily' ? formatYmd(now, userTimezone) : formatIsoWeek(now, userTimezone);
  const result = await commitAutomationPage({
    userId: ctx.userId,
    agentTaskId: ctx.agentTaskId,
    subFolderSlug: 'recaps',
    subFolderTitle: 'Recaps',
    subFolderAbstract: 'Daily and weekly recaps — reflections on what happened.',
    fireStamp,
    pageTitle: `${fireStamp} — ${parsed.title}`,
    pageAbstract: `Automation-generated ${variant} recap. ${fireStamp}.`,
    sections: parsed.sections,
    sourceCalls: activity.calls,
  });

  logger.info(
    {
      userId: ctx.userId,
      agentTaskId: ctx.agentTaskId,
      variant,
      pageSlug: result.pageSlug,
      sectionsCreated: result.sectionsCreated,
    },
    'recap handler: complete',
  );

  return { ...result, variant };
}

function parseVariant(payload: unknown): RecapVariant {
  if (payload && typeof payload === 'object') {
    const v = (payload as { variant?: unknown }).variant;
    if (typeof v === 'string' && (RECAP_VARIANTS as readonly string[]).includes(v)) {
      return v as RecapVariant;
    }
  }
  return 'daily';
}

function computeWindowStart(now: Date, variant: RecapVariant): Date {
  const ms = variant === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

// ── Prompt construction ───────────────────────────────────────────────────

const RECAP_SYSTEM_PROMPT_BASE = `You are writing a recap for the user — a reflective look back at the past WINDOW_LABEL of their life and work.

This is NOT a status report or a newsletter. It's a thoughtful, second-person reflection — the kind of recap a perceptive friend would write after watching the user's WINDOW_LABEL. The user reads this to step back and feel what just happened, not to scan a list of items they already know.

# Voice

- Second person, warm, calibrated. "You wrapped up the Consensus pitch deck this morning" not "The user wrapped up." Direct address, not impersonal narration.
- Match the energy of the WINDOW_LABEL. A quiet stretch deserves a short, contemplative recap. A busy one deserves a denser one. Don't pad a sparse window. Don't truncate a rich one.
- No corporate-newsletter cadence. Don't write "Here's what happened this week!" or end with "Keep up the great work!". Don't use emoji as section dividers.
- Acknowledge ambiguity. If a conversation didn't reach a decision, say so. If a todo lingered, name it. Don't manufacture narrative arcs that aren't in the data.
- Honor specifics over generalities. "You spent two long calls thinking through how social technology might shift" beats "You explored some concepts this week."
- Use the user's own language where it's distinctive. If they framed something as "the bottleneck of all bottlenecks", preserve their framing.

# Structure

Output a single markdown page with 2–4 sections. Section titles should be specific to the content ("# The Consensus deck took shape", "# A quiet day with one big decision") — NOT generic ("# Highlights", "# Updates"). Title the sections by what's *in* them, not by what kind of recap section they are.

Section flow guidance:
- Lead with the WINDOW_LABEL's overall texture or dominant thread.
- Group related items by project/theme rather than by category (calls vs notes vs todos). The user thinks in projects, not in data types.
- If a single topic dominated the window, ONE rich section about that topic > four shallow sections.
- If a decision or commitment got made, name it specifically.

# Length

LENGTH_GUIDANCE

# Format requirements

- Output ONLY the markdown page body — no preamble, no explanation, no "Here is the recap:" framing.
- Start with a single H1 line (# Title) — this is the recap's semantic title (date prefix is added separately). The title should be specific to the day/week, NOT generic ("Recap" or "Daily summary" are bad).
- Use H2 (## Section name) for each section. Section names should also be specific.
- Plain prose within sections. Bullet lists are OK when the content is genuinely list-shaped (a count of completed todos, a series of decisions), but the default is paragraphs.

# Never

- NEVER fabricate. If the activity window is genuinely thin, write a short recap acknowledging that — don't invent material to pad length.
- NEVER mention "based on the activity data" or "looking at the past week" — write naturally as if you observed it yourself.
- NEVER include timestamps in body text. Reference relative time when useful ("this morning", "around mid-week") — the page's wiki metadata carries the precise fire time.
- NEVER write a summary section at the end. The recap IS the summary; there's nothing to summarize.
- NEVER use [[slug]] cross-reference syntax — the renderer doesn't resolve it yet. Reference pages by name, not by slug.`;

const LENGTH_GUIDANCE_DAILY =
  '~250–500 words. Aim for the lower end on light days. A truly empty day = 1 short paragraph; do not pad.';
const LENGTH_GUIDANCE_WEEKLY =
  '~500–1000 words. Aim for the lower end on quiet weeks. A truly empty week = 2-3 short paragraphs.';

function buildRecapPrompt(
  variant: RecapVariant,
  activity: ActivityWindow,
): { systemPrompt: string; userMessage: string } {
  const windowLabel = variant === 'daily' ? 'day' : 'week';
  const lengthGuidance =
    variant === 'daily' ? LENGTH_GUIDANCE_DAILY : LENGTH_GUIDANCE_WEEKLY;
  const systemPrompt = RECAP_SYSTEM_PROMPT_BASE.replaceAll('WINDOW_LABEL', windowLabel).replace(
    'LENGTH_GUIDANCE',
    lengthGuidance,
  );

  const userMessage = `# Window
This ${windowLabel} covers ${activity.windowStart} through ${activity.windowEnd} (timezone: ${activity.userTimezone}).

# Activity
${JSON.stringify(
  {
    calls: activity.calls,
    notesActivity: activity.notesActivity,
    todos: activity.todos,
    research: activity.research,
    dreams: activity.dreams,
  },
  null,
  2,
)}

# Output
Write the recap. Output ONLY the markdown page body — no preamble. Start with the H1 title line.`;

  return { systemPrompt, userMessage };
}

// ── Pro call ─────────────────────────────────────────────────────────────

async function callPro(
  systemPrompt: string,
  userMessage: string,
): Promise<{ markdown: string; usage: UsageMetadata | undefined }> {
  const resp = await getGeminiClient().models.generateContent({
    model: RECAP_MODEL,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      temperature: 0.5,
    },
  });
  const markdown = resp.text?.trim();
  if (!markdown) {
    throw new Error(
      `recap handler: Pro returned empty response (finishReason=${resp.candidates?.[0]?.finishReason})`,
    );
  }
  return { markdown, usage: resp.usageMetadata };
}

// Re-export parser for any callers that were importing the recap-specific name.
export { parseAutomationMarkdown as parseRecapMarkdown } from '../commit.js';
