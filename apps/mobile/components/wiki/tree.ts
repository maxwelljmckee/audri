// Pure tree helpers for the wiki plugin's folder UI. All input is the flat
// list of pages from useWikiPages(); functions derive structural views.
//
// Performance: O(n) per call. Wikis at MVP scale (tens to low hundreds of
// pages) don't need indexes; if perf becomes an issue we can memoize on the
// pages reference.

import type { WikiPageDoc } from '../../lib/rxdb/schemas';

export interface WikiSearchHit {
  page: WikiPageDoc;
  ancestors: WikiPageDoc[];
}

export function getTopLevelPages(pages: WikiPageDoc[]): WikiPageDoc[] {
  return pages
    .filter((p) => p.parent_page_id === null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function getChildren(parentId: string | null, pages: WikiPageDoc[]): WikiPageDoc[] {
  return pages
    .filter((p) => p.parent_page_id === parentId)
    .sort((a, b) => a.title.localeCompare(b.title));
}

// Walk the parent_page_id chain from a leaf up to root. Returns ancestors in
// root-first order — so for `profile/work/calico-cyber` you get
// [profile, profile/work, calico-cyber]. The leaf itself is the last entry.
// Cycles are theoretically impossible (parent_page_id has FK constraints +
// ingestion enforces tree shape) but guarded against defensively.
export function getAncestorChain(pageId: string, pages: WikiPageDoc[]): WikiPageDoc[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const chain: WikiPageDoc[] = [];
  const seen = new Set<string>();
  let current: WikiPageDoc | undefined = byId.get(pageId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    if (!current.parent_page_id) break;
    current = byId.get(current.parent_page_id);
  }
  return chain;
}

// Substring search across title + agent_abstract + abstract. Case-insensitive.
// Each hit carries the full ancestor chain so the UI can render breadcrumbs
// alongside the match. Empty query returns empty array (UI distinguishes
// "search active with zero results" from "search not active" via the query
// string itself).
export function searchPages(query: string, pages: WikiPageDoc[]): WikiSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = pages.filter((p) => {
    const title = p.title.toLowerCase();
    const agentAbs = (p.agent_abstract ?? '').toLowerCase();
    const abs = (p.abstract ?? '').toLowerCase();
    return title.includes(q) || agentAbs.includes(q) || abs.includes(q);
  });
  return matches
    .map((page) => ({
      page,
      ancestors: getAncestorChain(page.id, pages).slice(0, -1),
    }))
    .sort((a, b) => {
      // Title-prefix matches surface before mid-word + abstract matches.
      const aTitleHit = a.page.title.toLowerCase().startsWith(q);
      const bTitleHit = b.page.title.toLowerCase().startsWith(q);
      if (aTitleHit !== bTitleHit) return aTitleHit ? -1 : 1;
      return a.page.title.localeCompare(b.page.title);
    });
}

export function countChildren(parentId: string, pages: WikiPageDoc[]): number {
  let count = 0;
  for (const p of pages) {
    if (p.parent_page_id === parentId) count++;
  }
  return count;
}
