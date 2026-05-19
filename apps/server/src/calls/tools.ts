// Live-agent tool implementations. Backs the function calls Audri emits
// mid-call (search_wiki / fetch_page / search_transcripts / fetch_transcript).
// Web search is handled by Gemini's built-in googleSearch grounding — no
// fulfillment endpoint needed for that.
//
// Architecture: mobile client receives the toolCall event from Gemini Live
// over the WebSocket, hits the endpoints in calls.controller.ts:tools, and
// forwards the response back to Gemini via session.sendToolResponse. Tools
// run server-side under the user's JWT so RLS scopes results correctly.

import {
  agents,
  and,
  callTranscripts,
  db,
  eq,
  isNull,
  sql,
  wikiPages,
  wikiSections,
} from '@audri/shared/db';

// Caps tuned for voice — the agent narrates results, so leaner is better.
// Research (apps/worker/src/research/vault-scan.ts) keeps 12 sections for
// prompt injection; live needs only enough for the model to pick a thread.
const SEARCH_MAX_RESULTS = 5;
const SEARCH_SNIPPET_CHARS = 300;
const FETCH_MAX_SECTION_CHARS = 2000;

export interface SearchWikiResult {
  page_slug: string;
  page_title: string;
  page_type: string;
  // Best matching section per page, snippet only (full content via fetch_page).
  matched_section_title: string | null;
  snippet: string;
}

// Postgres FTS over wiki_sections. Same shape as vault-scan but smaller cap +
// truncated snippet + dedup to one section per page. Live agent reads these
// out loud or uses them to inform a follow-up — the goal is "is there
// something on this topic?" not "give me everything."
export async function searchWiki(userId: string, query: string): Promise<SearchWikiResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const tsQuery = sql`websearch_to_tsquery('english', ${trimmed})`;
  const tsVector = sql`to_tsvector('english', ${wikiSections.content})`;

  const rows = await db
    .select({
      pageId: wikiPages.id,
      pageSlug: wikiPages.slug,
      pageTitle: wikiPages.title,
      pageType: wikiPages.type,
      sectionTitle: wikiSections.title,
      sectionContent: wikiSections.content,
      rank: sql<number>`ts_rank(${tsVector}, ${tsQuery})`,
    })
    .from(wikiSections)
    .innerJoin(wikiPages, eq(wikiPages.id, wikiSections.pageId))
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, 'user'),
        isNull(wikiPages.tombstonedAt),
        // Exclude archived pages — they remain navigable via direct slug
        // lookup but don't surface in search. Live agent shouldn't be
        // surfacing archived content as a current reference.
        isNull(wikiPages.archivedAt),
        isNull(wikiSections.tombstonedAt),
        sql`${tsVector} @@ ${tsQuery}`,
      ),
    )
    .orderBy(sql`ts_rank(${tsVector}, ${tsQuery}) DESC`)
    .limit(SEARCH_MAX_RESULTS * 4); // pull extra so dedup-by-page still hits the cap

  // Dedup to best section per page so we don't return five sections of
  // the same page when the page is broadly relevant.
  const bestByPage = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!bestByPage.has(r.pageId)) bestByPage.set(r.pageId, r);
  }

  return [...bestByPage.values()].slice(0, SEARCH_MAX_RESULTS).map((r) => ({
    page_slug: r.pageSlug,
    page_title: r.pageTitle,
    page_type: r.pageType,
    matched_section_title: r.sectionTitle,
    snippet: truncate(r.sectionContent, SEARCH_SNIPPET_CHARS),
  }));
}

export interface FetchPageResult {
  page_slug: string;
  page_title: string;
  page_type: string;
  abstract: string | null;
  // Page-level behavioral conventions for the Live Agent — read these and
  // RESPECT them when the user issues a directive targeting this page.
  // Null when no conventions set. See system-prompt §"Page-level agent
  // notes" for delivery rules.
  agent_notes: string | null;
  sections: Array<{
    title: string | null;
    content: string;
  }>;
}

// Fetch a single wiki page in full (truncated per section). Lookup is by
// slug — the live agent gets slugs from search_wiki results and from the
// preload's Notes-structure block.
export async function fetchPage(userId: string, slug: string): Promise<FetchPageResult | null> {
  const cleanedSlug = slug.trim();
  if (!cleanedSlug) return null;

  const [page] = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      type: wikiPages.type,
      abstract: wikiPages.abstract,
      // TODO(v0.4.0): replace with user_custom_rules join (scope='page').
      // wiki_pages.agent_notes was dropped 2026-05-19; stub to null until the
      // new read-path lands. See specs/customization-framework.md § LD11.
      agentNotes: sql<string | null>`NULL`,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, 'user'),
        eq(wikiPages.slug, cleanedSlug),
        isNull(wikiPages.tombstonedAt),
        // Archived pages aren't surfaced via fetch_page either. The live
        // agent shouldn't be steering the user toward archived content
        // as if it were current. Future: explicit `include_archived`
        // parameter for archived-browse use cases (V1+).
        isNull(wikiPages.archivedAt),
      ),
    )
    .limit(1);

  if (!page) return null;

  const sections = await db
    .select({
      title: wikiSections.title,
      content: wikiSections.content,
      sortOrder: wikiSections.sortOrder,
    })
    .from(wikiSections)
    .where(and(eq(wikiSections.pageId, page.id), isNull(wikiSections.tombstonedAt)))
    .orderBy(wikiSections.sortOrder);

  return {
    page_slug: page.slug,
    page_title: page.title,
    page_type: page.type,
    abstract: page.abstract,
    agent_notes: page.agentNotes,
    sections: sections.map((s) => ({
      title: s.title,
      content: truncate(s.content, FETCH_MAX_SECTION_CHARS),
    })),
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n).trimEnd()}…`;
}

// ── Cross-call retrieval ────────────────────────────────────────────────
// Two tools for reaching back into prior conversations. Live agent uses
// these when the user references a past call ("the books we discussed",
// "what did I say about X last week"). Wiki tools above retrieve the
// distilled knowledge graph; these retrieve the raw conversational record.

const TRANSCRIPT_SEARCH_SNIPPET_CHARS = 300;
const TRANSCRIPT_FETCH_MAX_TURN_CHARS = 1500;
const TRANSCRIPT_FETCH_MAX_TURNS = 60;

export interface SearchTranscriptsResult {
  transcript_id: string;
  agent_name: string;
  started_at: string;
  title: string | null;
  // Snippet from the best-matching turn (truncated). Lets the agent decide
  // whether the hit is worth fetching in full.
  snippet: string;
}

// FTS over call_transcripts.content. Content is a JSONB array of turns
// ({role, text, t, id, ...}); we cast to text and ts-vectorize the whole
// thing — keys ("role", "text") are noise in the index but the model
// doesn't see those, and at MVP transcript volume an unindexed sequential
// scan is acceptable. Add a generated tsvector column + GIN index when
// transcript counts cross ~10k/user.
//
// `limit` is optional — the live-agent endpoint passes 5 to keep its
// context tight; the UI endpoint passes undefined for unbounded results
// (UI shows the full result set, sorted by date client-side).
export async function searchTranscripts(
  userId: string,
  query: string,
  limit?: number,
): Promise<SearchTranscriptsResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const tsQuery = sql`websearch_to_tsquery('english', ${trimmed})`;
  const tsVector = sql`to_tsvector('english', ${callTranscripts.content}::text)`;

  const baseQuery = db
    .select({
      id: callTranscripts.id,
      startedAt: callTranscripts.startedAt,
      title: callTranscripts.title,
      content: callTranscripts.content,
      agentName: agents.name,
      rank: sql<number>`ts_rank(${tsVector}, ${tsQuery})`,
    })
    .from(callTranscripts)
    .innerJoin(agents, eq(agents.id, callTranscripts.agentId))
    .where(
      and(
        eq(callTranscripts.userId, userId),
        eq(callTranscripts.cancelled, false),
        sql`${tsVector} @@ ${tsQuery}`,
      ),
    )
    .orderBy(sql`ts_rank(${tsVector}, ${tsQuery}) DESC`);

  const rows = limit !== undefined ? await baseQuery.limit(limit) : await baseQuery;

  // Snippet extraction: walk the turn list, pick the first turn whose text
  // contains a query term (case-insensitive). Fall back to the first turn
  // when nothing matches (the FTS hit was on stopwords or structural noise).
  const queryTerms = trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  return rows.map((r) => {
    const turns = Array.isArray(r.content) ? (r.content as Array<{ text?: string }>) : [];
    const matchedTurn =
      turns.find(
        (t) =>
          typeof t.text === 'string' && queryTerms.some((w) => t.text?.toLowerCase().includes(w)),
      ) ?? turns[0];
    const snippet =
      matchedTurn && typeof matchedTurn.text === 'string'
        ? truncate(matchedTurn.text, TRANSCRIPT_SEARCH_SNIPPET_CHARS)
        : '';
    return {
      transcript_id: r.id,
      agent_name: r.agentName,
      started_at: r.startedAt.toISOString(),
      title: r.title,
      snippet,
    };
  });
}

export interface FetchTranscriptResult {
  transcript_id: string;
  agent_name: string;
  started_at: string;
  ended_at: string | null;
  title: string | null;
  turns: Array<{ role: string; text: string }>;
  // When the turn count exceeds TRANSCRIPT_FETCH_MAX_TURNS we return the
  // most recent N and set this flag. Avoids dumping an hour-long call into
  // the live agent's context.
  truncated: boolean;
}

// Fetch a single transcript by id. Returns the full turn list (subject to
// the per-turn / total-turn truncation caps above). Used after
// search_transcripts when the agent wants the full conversation context.
export async function fetchTranscript(
  userId: string,
  transcriptId: string,
): Promise<FetchTranscriptResult | null> {
  const cleanedId = transcriptId.trim();
  if (!cleanedId) return null;

  const [row] = await db
    .select({
      id: callTranscripts.id,
      startedAt: callTranscripts.startedAt,
      endedAt: callTranscripts.endedAt,
      title: callTranscripts.title,
      content: callTranscripts.content,
      cancelled: callTranscripts.cancelled,
      agentName: agents.name,
    })
    .from(callTranscripts)
    .innerJoin(agents, eq(agents.id, callTranscripts.agentId))
    .where(and(eq(callTranscripts.id, cleanedId), eq(callTranscripts.userId, userId)))
    .limit(1);

  if (!row || row.cancelled) return null;

  const rawTurns = Array.isArray(row.content)
    ? (row.content as Array<{ role?: string; text?: string }>)
    : [];
  const truncated = rawTurns.length > TRANSCRIPT_FETCH_MAX_TURNS;
  const sliced = truncated ? rawTurns.slice(-TRANSCRIPT_FETCH_MAX_TURNS) : rawTurns;

  return {
    transcript_id: row.id,
    agent_name: row.agentName,
    started_at: row.startedAt.toISOString(),
    ended_at: row.endedAt ? row.endedAt.toISOString() : null,
    title: row.title,
    turns: sliced
      .filter((t) => typeof t.text === 'string' && t.text.length > 0)
      .map((t) => ({
        role: typeof t.role === 'string' ? t.role : 'unknown',
        text: truncate(t.text as string, TRANSCRIPT_FETCH_MAX_TURN_CHARS),
      })),
    truncated,
  };
}
