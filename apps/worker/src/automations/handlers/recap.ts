// Recap handler — daily / weekly variants.
//
// Path: dispatch-agent-task.ts invokes this when an agent_task with
// kind='recap' is dequeued. Flow:
//   1. Determine variant (daily | weekly) from payload + compute window
//   2. Fetch activity-window snapshot
//   3. Call Pro with the recap prompt
//   4. Parse markdown output into title + sections
//   5. Commit: lazy-create /automations/ + /automations/recaps/, then
//      insert wiki_page + wiki_sections + history + source junctions
//   6. Record usage_events
//
// Output lands at:
//   slug:  automations/recaps/YYYY-MM-DD       (daily)
//   slug:  automations/recaps/YYYY-WK-NN-daily (weekly — ISO week)
//   title: "YYYY-MM-DD — <AI-picked semantic>"
//
// Source attribution: each section gets wiki_section_transcripts
// junctions for every call in the activity window. turn_id is a
// placeholder ("recap-source") since the recap doesn't cite a specific
// turn — it's a page-level citation that surfaces in the section UX.
// snippet carries the call title or first user-turn excerpt.

import { getGeminiClient } from '@audri/shared/gemini';
import {
  and,
  callTranscripts,
  db,
  eq,
  isNull,
  sql,
  wikiPages,
  wikiSectionHistory,
  wikiSectionTranscripts,
  wikiSections,
} from '@audri/shared/db';
import type { UsageMetadata } from '@google/genai';
import { logger } from '../../logger.js';
import { recordInferenceUsage } from '../../usage/record-inference.js';
import { type ActivityWindow, fetchActivityWindow } from '../activity-window.js';

export const RECAP_MODEL = 'gemini-3.1-pro-preview';
const RECAP_VARIANTS = ['daily', 'weekly'] as const;
type RecapVariant = (typeof RECAP_VARIANTS)[number];

export interface RecapPayload {
  // Which variant fires. Defaults to 'daily' if payload omits it.
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

  // 1. Activity snapshot. Recap consumes all slices.
  const activity = await fetchActivityWindow({
    userId: ctx.userId,
    windowStart,
    windowEnd: now,
    timezone: userTimezone,
  });

  // 2. Build prompt + call Pro.
  const { systemPrompt, userMessage } = buildRecapPrompt(variant, activity);
  const { markdown, usage } = await callPro(systemPrompt, userMessage);

  // 3. Record usage. Best-effort.
  void recordInferenceUsage({
    userId: ctx.userId,
    agentId: ctx.agentId ?? undefined,
    agentTaskId: ctx.agentTaskId,
    eventKind: 'ingestion', // closest existing kind — usage_event_kind doesn't yet have 'automation'
    model: RECAP_MODEL,
    usage,
  });

  // 4. Parse markdown into title + sections.
  const parsed = parseRecapMarkdown(markdown);
  if (parsed.sections.length === 0) {
    throw new Error('recap handler: parsed 0 sections from Pro output');
  }

  // 5. Commit the page.
  const fireStamp = formatFireStamp(now, userTimezone, variant);
  const dateLabel = formatDateLabel(now, userTimezone, variant);
  const pageTitle = `${dateLabel} — ${parsed.title}`;
  const result = await commitRecapPage({
    userId: ctx.userId,
    agentTaskId: ctx.agentTaskId,
    fireStamp,
    pageTitle,
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

async function fetchUserTimezone(userId: string): Promise<string> {
  // user_settings.timezone — falls back to UTC when unset.
  const result = (await db.execute(sql`
    SELECT timezone FROM user_settings WHERE user_id = ${userId} LIMIT 1
  `)) as unknown as { rows?: Array<{ timezone: string | null }> };
  return result.rows?.[0]?.timezone ?? 'UTC';
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

// ── Markdown parse ───────────────────────────────────────────────────────

export interface ParsedRecapSection {
  title: string;
  content: string;
}

export interface ParsedRecap {
  title: string;
  sections: ParsedRecapSection[];
}

// Parse the Pro output. Constrained format: leading H1 = title, each H2
// starts a section. No nested heading levels expected. Simple line-walk
// keeps the parser cheap + obvious.
export function parseRecapMarkdown(markdown: string): ParsedRecap {
  const lines = markdown.split('\n');
  let title = '';
  const sections: ParsedRecapSection[] = [];
  let currentSection: ParsedRecapSection | null = null;
  const flush = () => {
    if (currentSection) {
      currentSection.content = currentSection.content.trim();
      if (currentSection.content.length > 0 || currentSection.title.length > 0) {
        sections.push(currentSection);
      }
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h1 && !title) {
      title = h1[1]?.trim() ?? '';
      continue;
    }
    if (h2) {
      flush();
      currentSection = { title: h2[1]?.trim() ?? '', content: '' };
      continue;
    }
    if (currentSection) {
      currentSection.content += `${line}\n`;
    }
  }
  flush();

  // Fallback: if Pro returned content without an H1, use the first line
  // or a generic title. If no H2 sections, wrap the whole body into one
  // untitled section so we still commit something.
  if (!title) {
    title = sections[0]?.title || 'Recap';
  }
  if (sections.length === 0) {
    sections.push({ title: '', content: markdown.trim() });
  }

  return { title, sections };
}

// ── Commit ───────────────────────────────────────────────────────────────

interface CommitRecapPageOpts {
  userId: string;
  agentTaskId: string;
  fireStamp: string; // YYYY-MM-DD (daily) or YYYY-WK-NN (weekly)
  pageTitle: string;
  sections: ParsedRecapSection[];
  sourceCalls: ActivityWindow['calls'];
}

interface CommitRecapPageResult {
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  sectionsCreated: number;
}

async function commitRecapPage(opts: CommitRecapPageOpts): Promise<CommitRecapPageResult> {
  const pageSlug = `automations/recaps/${opts.fireStamp}`;
  return await db.transaction(async (tx) => {
    // Ensure /automations/ root exists.
    const automationsRoot = await ensureWikiPage(tx, {
      userId: opts.userId,
      slug: 'automations',
      title: 'Automations',
      type: 'note',
      parentPageId: null,
      agentAbstract: 'Outputs produced by recurring automations.',
    });
    // Ensure /automations/recaps/ subfolder exists.
    const recapsRoot = await ensureWikiPage(tx, {
      userId: opts.userId,
      slug: 'automations/recaps',
      title: 'Recaps',
      type: 'note',
      parentPageId: automationsRoot.id,
      agentAbstract: 'Daily and weekly recaps — reflections on what happened.',
    });

    // Insert the recap page itself.
    const [pageRow] = await tx
      .insert(wikiPages)
      .values({
        userId: opts.userId,
        scope: 'user',
        type: 'note',
        slug: pageSlug,
        parentPageId: recapsRoot.id,
        title: opts.pageTitle,
        agentAbstract: `Automation-generated recap. ${opts.fireStamp}.`,
      })
      .onConflictDoNothing({ target: [wikiPages.userId, wikiPages.scope, wikiPages.slug] })
      .returning({ id: wikiPages.id });
    if (!pageRow) {
      // Slug already exists — automation re-fire for the same fire-stamp.
      // Idempotent skip — don't double-write the same recap for the
      // same day/week.
      logger.warn(
        { userId: opts.userId, pageSlug },
        'recap handler: page already exists for fire-stamp — skipping insert',
      );
      const [existing] = await tx
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.userId, opts.userId),
            eq(wikiPages.scope, 'user'),
            eq(wikiPages.slug, pageSlug),
          ),
        )
        .limit(1);
      return {
        pageId: existing?.id ?? '',
        pageSlug,
        pageTitle: opts.pageTitle,
        sectionsCreated: 0,
      };
    }
    const pageId = pageRow.id;

    // Insert sections + history.
    let sortOrder = 0;
    for (const sec of opts.sections) {
      const [secRow] = await tx
        .insert(wikiSections)
        .values({
          pageId,
          title: sec.title || null,
          content: sec.content,
          sortOrder: sortOrder++,
        })
        .returning({ id: wikiSections.id });
      if (!secRow) continue;
      await tx.insert(wikiSectionHistory).values({
        sectionId: secRow.id,
        content: sec.content,
        editedBy: 'ai',
      });

      // Source attribution: junction rows for each call in the window.
      // turn_id placeholder ("recap-source") since the recap doesn't
      // cite a specific turn; snippet is the call title or first
      // user-turn excerpt for legibility on the section detail panel.
      for (const call of opts.sourceCalls) {
        const snippet = pickCallSnippet(call);
        if (!snippet) continue;
        await tx.insert(wikiSectionTranscripts).values({
          sectionId: secRow.id,
          transcriptId: call.transcriptId,
          turnId: 'recap-source',
          snippet,
        });
      }
    }

    void callTranscripts; // silence linter; we don't directly touch the table

    return {
      pageId,
      pageSlug,
      pageTitle: opts.pageTitle,
      sectionsCreated: opts.sections.length,
    };
  });
}

function pickCallSnippet(call: ActivityWindow['calls'][number]): string | null {
  if (call.title && call.title.length > 0) return call.title;
  if (call.summary && call.summary.length > 0) return call.summary.slice(0, 200);
  if (call.userTurnExcerpts[0]) return call.userTurnExcerpts[0].slice(0, 200);
  return null;
}

interface EnsureWikiPageOpts {
  userId: string;
  slug: string;
  title: string;
  // biome-ignore lint/suspicious/noExplicitAny: page_type pgEnum string literal
  type: any;
  parentPageId: string | null;
  agentAbstract: string;
}

// biome-ignore lint/suspicious/noExplicitAny: Drizzle's tx type is complex
async function ensureWikiPage(
  tx: any,
  opts: EnsureWikiPageOpts,
): Promise<{ id: string }> {
  const existing = await tx
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.userId, opts.userId),
        eq(wikiPages.scope, 'user'),
        eq(wikiPages.slug, opts.slug),
        isNull(wikiPages.tombstonedAt),
      ),
    )
    .limit(1);
  if (existing[0]) return { id: existing[0].id };
  const [inserted] = await tx
    .insert(wikiPages)
    .values({
      userId: opts.userId,
      scope: 'user',
      type: opts.type,
      slug: opts.slug,
      parentPageId: opts.parentPageId,
      title: opts.title,
      agentAbstract: opts.agentAbstract,
    })
    .onConflictDoNothing({ target: [wikiPages.userId, wikiPages.scope, wikiPages.slug] })
    .returning({ id: wikiPages.id });
  if (inserted) return { id: inserted.id };
  // Conflict race — re-query and return.
  const [fallback] = await tx
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.userId, opts.userId),
        eq(wikiPages.scope, 'user'),
        eq(wikiPages.slug, opts.slug),
      ),
    )
    .limit(1);
  if (!fallback) throw new Error(`ensureWikiPage: failed to resolve ${opts.slug}`);
  return { id: fallback.id };
}

// ── Date formatting ─────────────────────────────────────────────────────

function formatFireStamp(now: Date, timezone: string, variant: RecapVariant): string {
  if (variant === 'daily') return formatYmd(now, timezone);
  // Weekly: ISO week-of-year format YYYY-WKNN.
  return formatIsoWeek(now, timezone);
}

function formatDateLabel(now: Date, timezone: string, variant: RecapVariant): string {
  if (variant === 'daily') return formatYmd(now, timezone);
  return formatIsoWeek(now, timezone);
}

function formatYmd(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

function formatIsoWeek(date: Date, timezone: string): string {
  // ISO week starts on Monday. Algorithm: shift to Thursday of the
  // target week, then floor to Jan 1 + count weeks.
  const ymd = formatYmd(date, timezone);
  const [y, m, d] = ymd.split('-').map(Number);
  const local = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  const dayOfWeek = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((local.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${local.getUTCFullYear()}-WK${String(weekNum).padStart(2, '0')}`;
}
