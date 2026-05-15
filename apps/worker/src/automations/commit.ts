// Shared commit + parse + utilities used by every automation handler that
// produces a markdown wiki page (recap, brief_me, stalled_work; dreaming
// will join later). Each handler picks its own slug prefix, parent folder
// metadata, and date label, then hands the parsed sections + source calls
// here.
//
// Layout enforced by `subFolderSlug`:
//   /automations/                       (lazy-created note page)
//     /automations/<subFolderSlug>/     (lazy-created note page)
//       /automations/<subFolderSlug>/<fireStamp>  ← the synthesis page
//
// Idempotency: the page slug carries the fire-stamp (e.g. YYYY-MM-DD), so
// re-firing the same day's automation is a no-op via
// onConflictDoNothing — we don't double-write.

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
import { logger } from '../logger.js';
import type { ActivityWindow } from './activity-window.js';

// ── Timezone lookup ──────────────────────────────────────────────────────

// user_settings.timezone — falls back to UTC when unset.
export async function fetchUserTimezone(userId: string): Promise<string> {
  // db.execute() returns the postgres-js Result Array directly, not
  // a { rows } shape. Index the array.
  const result = (await db.execute(sql`
    SELECT timezone FROM user_settings WHERE user_id = ${userId} LIMIT 1
  `)) as unknown as Array<{ timezone: string | null }>;
  return result[0]?.timezone ?? 'UTC';
}

// ── Markdown parse ───────────────────────────────────────────────────────
//
// Constrained format: leading H1 = title, each H2 starts a section. No
// nested heading levels expected. Simple line-walk keeps the parser cheap
// + obvious. Fallback: if Pro returned content without an H1, use the
// first section title or a generic title; if no H2 sections, wrap the
// whole body into one untitled section so we still commit something.

export interface ParsedAutomationSection {
  title: string;
  content: string;
}

export interface ParsedAutomationPage {
  title: string;
  sections: ParsedAutomationSection[];
}

export function parseAutomationMarkdown(
  markdown: string,
  fallbackTitle: string,
): ParsedAutomationPage {
  const lines = markdown.split('\n');
  let title = '';
  const sections: ParsedAutomationSection[] = [];
  let currentSection: ParsedAutomationSection | null = null;
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

  if (!title) title = sections[0]?.title || fallbackTitle;
  if (sections.length === 0) sections.push({ title: '', content: markdown.trim() });

  return { title, sections };
}

// ── Lazy wiki-page ensure ────────────────────────────────────────────────

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
async function ensureWikiPage(tx: any, opts: EnsureWikiPageOpts): Promise<{ id: string }> {
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

// ── Source-attribution snippet pick ──────────────────────────────────────

function pickCallSnippet(call: ActivityWindow['calls'][number]): string | null {
  if (call.title && call.title.length > 0) return call.title;
  if (call.summary && call.summary.length > 0) return call.summary.slice(0, 200);
  if (call.userTurnExcerpts[0]) return call.userTurnExcerpts[0].slice(0, 200);
  return null;
}

// ── Commit ───────────────────────────────────────────────────────────────

export interface CommitAutomationPageOpts {
  userId: string;
  agentTaskId: string;
  // Sub-folder under /automations/ — 'recaps', 'briefs', 'stalled', etc.
  subFolderSlug: string;
  // Sub-folder page title + abstract (used only on lazy-create).
  subFolderTitle: string;
  subFolderAbstract: string;
  // Fire-stamp suffix (YYYY-MM-DD daily, YYYY-WKNN weekly, etc.).
  fireStamp: string;
  // Full page title including date prefix.
  pageTitle: string;
  // Per-page abstract for the agent-readable summary column.
  pageAbstract: string;
  sections: ParsedAutomationSection[];
  sourceCalls: ActivityWindow['calls'];
}

export interface CommitAutomationPageResult {
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  sectionsCreated: number;
}

const AUTOMATIONS_ROOT_ABSTRACT = 'Outputs produced by recurring automations.';

export async function commitAutomationPage(
  opts: CommitAutomationPageOpts,
): Promise<CommitAutomationPageResult> {
  const pageSlug = `automations/${opts.subFolderSlug}/${opts.fireStamp}`;
  return await db.transaction(async (tx) => {
    const automationsRoot = await ensureWikiPage(tx, {
      userId: opts.userId,
      slug: 'automations',
      title: 'Automations',
      type: 'note',
      parentPageId: null,
      agentAbstract: AUTOMATIONS_ROOT_ABSTRACT,
    });
    const subFolderRoot = await ensureWikiPage(tx, {
      userId: opts.userId,
      slug: `automations/${opts.subFolderSlug}`,
      title: opts.subFolderTitle,
      type: 'note',
      parentPageId: automationsRoot.id,
      agentAbstract: opts.subFolderAbstract,
    });

    const [pageRow] = await tx
      .insert(wikiPages)
      .values({
        userId: opts.userId,
        scope: 'user',
        type: 'note',
        slug: pageSlug,
        parentPageId: subFolderRoot.id,
        title: opts.pageTitle,
        agentAbstract: opts.pageAbstract,
      })
      .onConflictDoNothing({ target: [wikiPages.userId, wikiPages.scope, wikiPages.slug] })
      .returning({ id: wikiPages.id });

    if (!pageRow) {
      logger.warn(
        { userId: opts.userId, pageSlug },
        'commitAutomationPage: page already exists for fire-stamp — skipping insert',
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
      // turn_id placeholder ("automation-source") since the synthesis
      // doesn't cite a specific turn — page-level citation surfaces
      // in the section detail panel.
      for (const call of opts.sourceCalls) {
        const snippet = pickCallSnippet(call);
        if (!snippet) continue;
        await tx.insert(wikiSectionTranscripts).values({
          sectionId: secRow.id,
          transcriptId: call.transcriptId,
          turnId: 'automation-source',
          snippet,
        });
      }
    }

    void callTranscripts; // silence linter; the type-only import covers junctions

    return {
      pageId,
      pageSlug,
      pageTitle: opts.pageTitle,
      sectionsCreated: opts.sections.length,
    };
  });
}

// ── Date label helpers (shared across handlers) ──────────────────────────

export function formatYmd(date: Date, timezone: string): string {
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

// ISO week-of-year format YYYY-WKNN. ISO week starts on Monday.
// Algorithm: shift to Thursday of the target week, then floor to
// Jan 1 + count weeks.
export function formatIsoWeek(date: Date, timezone: string): string {
  const ymd = formatYmd(date, timezone);
  const [y, m, d] = ymd.split('-').map(Number);
  const local = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  const dayOfWeek = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((local.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${local.getUTCFullYear()}-WK${String(weekNum).padStart(2, '0')}`;
}
