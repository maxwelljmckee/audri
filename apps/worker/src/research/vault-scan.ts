// Vault scan — given a research query, find the user's existing wiki pages
// and sections most relevant to the topic. Output is fed back into the
// research prompt as `## Existing knowledge` so the model researches the
// GAP between what the user already knows and the world, rather than
// re-deriving everything from scratch.
//
// v0.2 Stage 1 of vault-first delta research (item #8). Implementation is
// Postgres FTS via `to_tsvector('english', content)` + `ts_rank` ordering.
// The existing GIN index `wiki_sections_content_fts` makes this cheap.

import {
  and,
  db,
  eq,
  isNull,
  sql,
  wikiPages,
  wikiSections,
} from '@audri/shared/db';

// Cap on retrieved sections to keep prompt token budget bounded. 12 covers
// the long tail for most topics; if a topic is so broad we'd want >12,
// research at this granularity is the wrong tool anyway.
const MAX_SECTIONS = 12;

export interface VaultScanSection {
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  pageType: string;
  sectionId: string;
  sectionTitle: string | null;
  sectionContent: string;
  rank: number;
}

export interface VaultScanResult {
  query: string;
  sections: VaultScanSection[];
}

/**
 * Run an FTS scan over the user's wiki for sections matching the query.
 * Returns top-ranked sections plus their parent page metadata.
 */
export async function vaultScan(
  userId: string,
  query: string,
): Promise<VaultScanResult> {
  const trimmed = query.trim();
  if (!trimmed) return { query: trimmed, sections: [] };

  // websearch_to_tsquery is the friendlier query mode — handles natural-
  // language input (no operators required) and tolerates noise. Falls back
  // gracefully on weird queries.
  const tsQuery = sql`websearch_to_tsquery('english', ${trimmed})`;
  const tsVector = sql`to_tsvector('english', ${wikiSections.content})`;

  const rows = await db
    .select({
      pageId: wikiPages.id,
      pageSlug: wikiPages.slug,
      pageTitle: wikiPages.title,
      pageType: wikiPages.type,
      sectionId: wikiSections.id,
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
        isNull(wikiSections.tombstonedAt),
        sql`${tsVector} @@ ${tsQuery}`,
      ),
    )
    .orderBy(sql`ts_rank(${tsVector}, ${tsQuery}) DESC`)
    .limit(MAX_SECTIONS);

  return {
    query: trimmed,
    sections: rows.map((r) => ({
      pageId: r.pageId,
      pageSlug: r.pageSlug,
      pageTitle: r.pageTitle,
      pageType: r.pageType,
      sectionId: r.sectionId,
      sectionTitle: r.sectionTitle,
      sectionContent: r.sectionContent,
      rank: r.rank,
    })),
  };
}

/**
 * Render the vault scan as a prompt-friendly markdown block. Empty result
 * returns a string explicitly noting "no existing knowledge" so the model
 * doesn't have to infer.
 */
export function renderVaultScan(scan: VaultScanResult): string {
  if (scan.sections.length === 0) {
    return [
      '## Existing knowledge',
      '',
      "_The user has no existing notes on this topic._ Research from scratch.",
    ].join('\n');
  }

  // Group sections by page so the model sees the parent → section structure
  // it'll need to reference in the delta output.
  const byPageId = new Map<string, VaultScanSection[]>();
  for (const s of scan.sections) {
    const list = byPageId.get(s.pageId) ?? [];
    list.push(s);
    byPageId.set(s.pageId, list);
  }

  const blocks: string[] = ['## Existing knowledge', ''];
  blocks.push(
    "_Sections from the user's existing notes that match the research topic. " +
      'Reference these by `page_id` and `section_id` in your delta output. ' +
      'Bias your external research toward gaps and stale facts in this set, ' +
      'NOT toward re-deriving what the user already has._',
    '',
  );

  for (const [pageId, sections] of byPageId.entries()) {
    const first = sections[0];
    if (!first) continue;
    blocks.push(`### ${first.pageTitle} _(\`${first.pageSlug}\`, type=${first.pageType})_`);
    blocks.push(`\`page_id: ${pageId}\``);
    for (const s of sections) {
      blocks.push('');
      blocks.push(`**${s.sectionTitle ?? '(untitled section)'}** \`section_id: ${s.sectionId}\``);
      blocks.push(s.sectionContent);
    }
    blocks.push('');
  }

  return blocks.join('\n');
}
