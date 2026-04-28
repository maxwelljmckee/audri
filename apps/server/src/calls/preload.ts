// Generic-call context preload. Reads the user's profile + agent-scope notes
// + recently-touched wiki pages, and renders them as a "What I know about
// you" block injected into the system prompt.
//
// Onboarding writes profile content; without this, generic calls open without
// any of that grounding and feel cold-start. This is the payoff for slice 6.
//
// Token budget is informal — we cap aggressively per-section so a verbose
// profile doesn't blow the context window. "Recent topics" surfaces via
// recently-updated wiki pages — those are richer than call summaries since
// they reflect what was actually extracted and considered worth remembering.

import { and, db, desc, eq, isNull, ne, sql } from '@audri/shared/db';
import { callTranscripts, wikiPages, wikiSections } from '@audri/shared/db';

const RECENT_PAGES_LIMIT = 8;
const MAX_SECTION_CHARS = 1200;
const INCOMPLETE_CALL_LOOKBACK_HOURS = 24;

interface PageWithSections {
  slug: string;
  title: string;
  agentAbstract: string;
  abstract: string | null;
  sections: Array<{ title: string | null; content: string }>;
}

interface RecentPage {
  slug: string;
  title: string;
  scope: 'user' | 'agent';
  updatedAt: Date;
  agentAbstract: string;
}

interface IncompleteCall {
  endedAt: Date;
  endReason: string;
  // Slugs of pages that ingestion touched on this transcript — useful for
  // the agent to say "we were talking about X." Empty if nothing was
  // extracted (the call ended before substantive content).
  touchedSlugs: string[];
}

interface PreloadData {
  profile: PageWithSections[];
  agentNotes: PageWithSections[];
  recentPages: RecentPage[];
  incompleteCall: IncompleteCall | null;
}

export async function loadGenericCallContext(userId: string): Promise<PreloadData> {
  const [profile, agentNotes, recentPages, incompleteCall] = await Promise.all([
    fetchPagesByPrefix(userId, 'user', 'profile'),
    fetchPagesByPrefix(userId, 'agent', 'assistant'),
    fetchRecentPages(userId),
    fetchMostRecentIncompleteCall(userId),
  ]);

  return { profile, agentNotes, recentPages, incompleteCall };
}

async function fetchPagesByPrefix(
  userId: string,
  scope: 'user' | 'agent',
  rootSlug: string,
): Promise<PageWithSections[]> {
  // Match either the root page or any descendant by slug-prefix. Slug
  // hierarchy is path-like (e.g. `profile/goals`).
  const rows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      agentAbstract: wikiPages.agentAbstract,
      abstract: wikiPages.abstract,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, scope),
        isNull(wikiPages.tombstonedAt),
        sql`(${wikiPages.slug} = ${rootSlug} OR ${wikiPages.slug} LIKE ${`${rootSlug}/%`})`,
      ),
    );

  if (rows.length === 0) return [];

  const slugs = rows.map((r) => r.slug);
  const sectionRows = await db
    .select({
      pageSlug: wikiPages.slug,
      title: wikiSections.title,
      content: wikiSections.content,
      sortOrder: wikiSections.sortOrder,
    })
    .from(wikiSections)
    .innerJoin(wikiPages, eq(wikiPages.id, wikiSections.pageId))
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, scope),
        isNull(wikiSections.tombstonedAt),
        sql`${wikiPages.slug} = ANY(${slugs})`,
      ),
    )
    .orderBy(wikiSections.sortOrder);

  const sectionsBySlug = new Map<string, Array<{ title: string | null; content: string }>>();
  for (const s of sectionRows) {
    const list = sectionsBySlug.get(s.pageSlug) ?? [];
    list.push({ title: s.title, content: truncate(s.content, MAX_SECTION_CHARS) });
    sectionsBySlug.set(s.pageSlug, list);
  }

  // Skip empty pages — no point taking up tokens for a stub.
  return rows
    .map((r) => ({ ...r, sections: sectionsBySlug.get(r.slug) ?? [] }))
    .filter((p) => p.sections.length > 0 || p.abstract);
}

async function fetchRecentPages(userId: string): Promise<RecentPage[]> {
  const rows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      scope: wikiPages.scope,
      updatedAt: wikiPages.updatedAt,
      agentAbstract: wikiPages.agentAbstract,
    })
    .from(wikiPages)
    .where(and(eq(wikiPages.userId, userId), isNull(wikiPages.tombstonedAt)))
    .orderBy(desc(wikiPages.updatedAt))
    .limit(RECENT_PAGES_LIMIT);

  return rows as RecentPage[];
}

// Most recent non-user-ended call within the lookback window. Used to offer
// "looks like we got cut off — want to wrap up?" in the next generic call.
// Cancelled calls are excluded (the user explicitly killed them).
async function fetchMostRecentIncompleteCall(userId: string): Promise<IncompleteCall | null> {
  const cutoff = new Date(Date.now() - INCOMPLETE_CALL_LOOKBACK_HOURS * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: callTranscripts.id,
      endedAt: callTranscripts.endedAt,
      endReason: callTranscripts.endReason,
    })
    .from(callTranscripts)
    .where(
      and(
        eq(callTranscripts.userId, userId),
        eq(callTranscripts.cancelled, false),
        ne(callTranscripts.endReason, 'user_ended'),
        sql`${callTranscripts.endedAt} IS NOT NULL`,
        sql`${callTranscripts.endedAt} >= ${cutoff.toISOString()}`,
      ),
    )
    .orderBy(desc(callTranscripts.endedAt))
    .limit(1);

  const row = rows[0];
  if (!row || !row.endedAt) return null;

  // Pull the touched-page slugs from this transcript's wiki_log row, if
  // ingestion has run yet. If not, the agent will just have to ask "what
  // were we talking about" the soft way.
  const logRows = await db.execute<{ slugs: string[] }>(sql`
    SELECT (ref->>'slugs')::jsonb #>> '{}' AS slugs
    FROM wiki_log
    WHERE user_id = ${userId}
      AND kind = 'ingest'
      AND ref->>'transcriptId' = ${row.id}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  let touchedSlugs: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: postgres-driver row shape varies; defensive parse below
  const rawSlugs = (logRows[0] as any)?.slugs;
  if (typeof rawSlugs === 'string') {
    try {
      const parsed = JSON.parse(rawSlugs);
      if (Array.isArray(parsed)) touchedSlugs = parsed.filter((s) => typeof s === 'string');
    } catch {
      /* ignore */
    }
  } else if (Array.isArray(rawSlugs)) {
    touchedSlugs = rawSlugs.filter((s: unknown) => typeof s === 'string');
  }

  return {
    endedAt: row.endedAt,
    endReason: row.endReason ?? 'unknown',
    touchedSlugs,
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n).trimEnd()}…`;
}

// Render preload data into the markdown block injected into the system
// prompt. Sections are explicitly labeled so the model knows the provenance
// (profile = facts about the user, agent notes = your private observations,
// recent pages = where activity has been concentrated).
export function renderPreloadBlock(data: PreloadData): string {
  if (
    data.profile.length === 0 &&
    data.agentNotes.length === 0 &&
    data.recentPages.length === 0 &&
    !data.incompleteCall
  ) {
    return '';
  }

  const parts: string[] = ['# What you know about the user'];

  if (data.incompleteCall) {
    parts.push('', '## Last call cut off', renderIncompleteCall(data.incompleteCall));
  }

  if (data.profile.length > 0) {
    parts.push('', '## Profile', renderPages(data.profile));
  }

  if (data.agentNotes.length > 0) {
    parts.push(
      '',
      '## Your private notes (agent-scope)',
      'These are observations you’ve recorded across past conversations. The user does not see them directly.',
      renderPages(data.agentNotes),
    );
  }

  if (data.recentPages.length > 0) {
    parts.push('', '## Recently active wiki pages', renderRecentPages(data.recentPages));
  }

  parts.push(
    '',
    '---',
    'Use this context naturally. Don’t recite it back — but reference it when relevant ("you mentioned X last time…", "I know you’re working on Y…"). If something seems missing or stale, you can ask. Never tell the user "I don\'t know anything about you" — you do; it\'s above.',
  );

  if (data.incompleteCall) {
    parts.push(
      '',
      'Special: your last call ended unexpectedly (see "Last call cut off" above). Open this call by acknowledging that briefly and offering to pick up where you left off — but don\'t insist; let the user redirect if they\'ve moved on.',
    );
  }

  return parts.join('\n');
}

function renderIncompleteCall(c: IncompleteCall): string {
  const when = formatRelative(c.endedAt);
  const reasonLabel: Record<string, string> = {
    silence_timeout: 'silence timeout',
    network_drop: 'network dropped',
    app_backgrounded: 'app went to background',
    cancelled: 'cancelled',
  };
  const reason = reasonLabel[c.endReason] ?? c.endReason;
  const lines = [`Ended ${when} — reason: ${reason}.`];
  if (c.touchedSlugs.length > 0) {
    lines.push(
      `Topics covered before the cutoff: ${c.touchedSlugs.map((s) => `\`${s}\``).join(', ')}.`,
    );
  } else {
    lines.push('No substantive topics had been extracted yet.');
  }
  return lines.join('\n');
}

function renderPages(pages: PageWithSections[]): string {
  return pages
    .map((p) => {
      const header = `### ${p.title} (\`${p.slug}\`)`;
      const abstract = p.abstract ?? p.agentAbstract;
      const sectionText = p.sections
        .map((s) => (s.title ? `**${s.title}**\n${s.content}` : s.content))
        .join('\n\n');
      return [header, abstract, '', sectionText].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function renderRecentPages(pages: RecentPage[]): string {
  return pages
    .map(
      (p) =>
        `- \`${p.slug}\` (${p.scope}, ${formatRelative(p.updatedAt)}) — ${p.agentAbstract}`,
    )
    .join('\n');
}

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}
