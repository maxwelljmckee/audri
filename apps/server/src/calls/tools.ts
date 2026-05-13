// Live-agent tool implementations. Backs the function calls Audri emits
// mid-call (search_wiki / fetch_page). Web search is handled by Gemini's
// built-in googleSearch grounding — no fulfillment endpoint needed for that.
//
// Architecture: mobile client receives the toolCall event from Gemini Live
// over the WebSocket, hits the endpoints in calls.controller.ts:tools, and
// forwards the response back to Gemini via session.sendToolResponse. Tools
// run server-side under the user's JWT so RLS scopes results correctly.

import { and, db, eq, isNull, sql, wikiPages, wikiSections } from '@audri/shared/db';

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
    sections: sections.map((s) => ({
      title: s.title,
      content: truncate(s.content, FETCH_MAX_SECTION_CHARS),
    })),
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n).trimEnd()}…`;
}
