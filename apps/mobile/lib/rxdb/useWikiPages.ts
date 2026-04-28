// Reactive RxDB query hooks for wiki content. Re-render when the underlying
// collection changes (server fan-out lands new pages, user edits a section).

import { useEffect, useState } from 'react';
import { getDatabase } from './database';
import type { WikiPageDoc, WikiSectionDoc } from './schemas';

// Pages are sorted by **section count desc** (most-written-about first), with
// updated_at desc as tiebreak. Section count is the proxy for "topics that
// got the user's attention" — pages with many sections reflect real engagement,
// pages with one stub section are noise. RxDB has no joins so we count
// client-side by subscribing to both collections and indexing by page_id.
export function useWikiPages(): WikiPageDoc[] {
  const [pages, setPages] = useState<WikiPageDoc[]>([]);
  const [sectionCounts, setSectionCounts] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let pagesSub: { unsubscribe: () => void } | undefined;
    let sectionsSub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      pagesSub = db.collections.wiki_pages
        .find({ selector: { tombstoned_at: null, scope: 'user' } })
        // biome-ignore lint/suspicious/noExplicitAny: RxDocument type is narrow; toJSON returns the typed doc shape
        .$.subscribe((docs: any[]) => {
          setPages(docs.map((d) => d.toJSON() as WikiPageDoc));
        });

      sectionsSub = db.collections.wiki_sections
        .find({ selector: { tombstoned_at: null } })
        // biome-ignore lint/suspicious/noExplicitAny: same
        .$.subscribe((docs: any[]) => {
          const counts = new Map<string, number>();
          for (const d of docs) {
            const pageId = d.page_id as string;
            counts.set(pageId, (counts.get(pageId) ?? 0) + 1);
          }
          setSectionCounts(counts);
        });
    });

    return () => {
      cancelled = true;
      pagesSub?.unsubscribe();
      sectionsSub?.unsubscribe();
    };
  }, []);

  return [...pages].sort((a, b) => {
    const countDiff = (sectionCounts.get(b.id) ?? 0) - (sectionCounts.get(a.id) ?? 0);
    if (countDiff !== 0) return countDiff;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

export function useWikiSectionsForPage(pageId: string | null): WikiSectionDoc[] {
  const [sections, setSections] = useState<WikiSectionDoc[]>([]);

  useEffect(() => {
    if (!pageId) {
      setSections([]);
      return;
    }
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.wiki_sections
        .find({
          selector: { page_id: pageId, tombstoned_at: null },
          sort: [{ sort_order: 'asc' }],
        })
        // biome-ignore lint/suspicious/noExplicitAny: same as above
        .$.subscribe((docs: any[]) => {
          setSections(docs.map((d) => d.toJSON() as WikiSectionDoc));
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [pageId]);

  return sections;
}
