// Compact wiki-index query for Flash candidate retrieval.
// Per specs/flash-retrieval-prompt.md §4.1 — projects all of the user's
// user-scope (non-tombstoned) wiki_pages to { slug, title, type, parent_slug,
// agent_abstract }. No section content, no abstract.

import { aliasedTable, db, eq, isNull, wikiPages } from '@audri/shared/db';
import { and } from '@audri/shared/db';

export interface WikiIndexEntry {
  slug: string;
  title: string;
  type: string;
  parent_slug: string | null;
  agent_abstract: string;
}

export async function fetchUserWikiIndex(userId: string): Promise<WikiIndexEntry[]> {
  const parents = aliasedTable(wikiPages, 'parents');
  const rows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      type: wikiPages.type,
      parentSlug: parents.slug,
      agentAbstract: wikiPages.agentAbstract,
    })
    .from(wikiPages)
    .leftJoin(parents, eq(wikiPages.parentPageId, parents.id))
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, 'user'),
        isNull(wikiPages.tombstonedAt),
      ),
    );

  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    type: r.type,
    parent_slug: r.parentSlug,
    agent_abstract: r.agentAbstract,
  }));
}
