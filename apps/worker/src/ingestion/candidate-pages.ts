// Fully-joined page representation that Pro fan-out reads — page metadata +
// ordered sections. Per specs/fan-out-prompt.md input contract.

import {
  and,
  asc,
  db,
  eq,
  inArray,
  isNull,
  wikiPages,
  wikiSections,
} from '@audri/shared/db';

export interface FullSection {
  id: string;
  title: string | null;
  content: string;
  sort_order: number;
}

export interface CandidatePage {
  id: string;
  slug: string;
  title: string;
  type: string;
  parent_slug: string | null;
  agent_abstract: string;
  abstract: string | null;
  sections: FullSection[];
}

export async function fetchCandidatePages(
  userId: string,
  slugs: string[],
): Promise<CandidatePage[]> {
  if (slugs.length === 0) return [];

  // Fetch the candidate page metadata.
  const pages = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.userId, userId),
        eq(wikiPages.scope, 'user'),
        inArray(wikiPages.slug, slugs),
        isNull(wikiPages.tombstonedAt),
      ),
    );

  if (pages.length === 0) return [];

  // Build slug-by-id map for parent lookups (parents may live outside the
  // candidate set; do a separate query if any parent IDs are unmapped).
  const pageById = new Map(pages.map((p) => [p.id, p]));
  const parentIds = pages
    .map((p) => p.parentPageId)
    .filter((id): id is string => id !== null && !pageById.has(id));

  const parentSlugById = new Map<string, string>();
  if (parentIds.length > 0) {
    const parents = await db
      .select({ id: wikiPages.id, slug: wikiPages.slug })
      .from(wikiPages)
      .where(inArray(wikiPages.id, parentIds));
    for (const p of parents) parentSlugById.set(p.id, p.slug);
  }

  // Fetch all live sections for these pages, ordered.
  const pageIds = pages.map((p) => p.id);
  const sections = await db
    .select()
    .from(wikiSections)
    .where(and(inArray(wikiSections.pageId, pageIds), isNull(wikiSections.tombstonedAt)))
    .orderBy(asc(wikiSections.sortOrder));

  const sectionsByPage = new Map<string, FullSection[]>();
  for (const s of sections) {
    const list = sectionsByPage.get(s.pageId) ?? [];
    list.push({
      id: s.id,
      title: s.title,
      content: s.content,
      sort_order: s.sortOrder,
    });
    sectionsByPage.set(s.pageId, list);
  }

  return pages.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    type: p.type,
    parent_slug: p.parentPageId
      ? (pageById.get(p.parentPageId)?.slug ?? parentSlugById.get(p.parentPageId) ?? null)
      : null,
    agent_abstract: p.agentAbstract,
    abstract: p.abstract,
    sections: sectionsByPage.get(p.id) ?? [],
  }));
}
