// Subtree-scoped wiki index — only the descendants of `scopeRootPageId`
// (inclusive). Used by the upload-ingestion pipeline so Flash + Pro
// can only write inside the explicit attachment target.
//
// Why subtree-scoped: when a user attaches a doc to a specific wiki
// page (e.g. projects/consensus), they want the doc's content to flow
// INTO that subtree — concepts/sub-projects/source pages under
// consensus — not into unrelated parts of their wiki. Avoids
// cross-project contamination (a paper attached to Project A
// accidentally seeding pages under Project B).
//
// Closure built via WITH RECURSIVE on wiki_pages.parent_page_id.
//
// Same return shape as `fetchUserWikiIndex` so Flash retrieval can
// consume both interchangeably.

import { db, sql } from '@audri/shared/db';
import type { WikiIndexEntry } from '../ingestion/wiki-index.js';

interface RawIndexRow {
  slug: string;
  title: string;
  type: string;
  parent_slug: string | null;
  agent_abstract: string;
}

export async function fetchScopedWikiIndex(
  userId: string,
  scopeRootPageId: string,
): Promise<WikiIndexEntry[]> {
  // Recursive CTE walks parent_page_id from the scope root down.
  // The base case is the root itself; the recursive step joins
  // children. We filter to non-tombstoned, non-archived, user-scope
  // pages throughout — same exclusions as the un-scoped index.
  //
  // The outer SELECT joins to the parent_page_id chain again to
  // surface `parent_slug` for each row, matching WikiIndexEntry shape.
  // Cast `type` to text in BOTH branches of the recursive UNION — Postgres
  // requires matching column types across branches and the base case's raw
  // `page_type` enum vs the recursive step's `::text` cast tripped 42804
  // ("UNION types page_type and text cannot be matched") on the first real
  // attempt 2026-05-15.
  const result = (await db.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, slug, title, type::text AS type, parent_page_id, agent_abstract
      FROM wiki_pages
      WHERE id = ${scopeRootPageId}
        AND user_id = ${userId}
        AND scope = 'user'
        AND tombstoned_at IS NULL
        AND archived_at IS NULL
      UNION ALL
      SELECT p.id, p.slug, p.title, p.type::text, p.parent_page_id, p.agent_abstract
      FROM wiki_pages p
      INNER JOIN subtree s ON p.parent_page_id = s.id
      WHERE p.user_id = ${userId}
        AND p.scope = 'user'
        AND p.tombstoned_at IS NULL
        AND p.archived_at IS NULL
    )
    SELECT
      s.slug,
      s.title,
      s.type,
      parents.slug AS parent_slug,
      s.agent_abstract
    FROM subtree s
    LEFT JOIN wiki_pages parents ON s.parent_page_id = parents.id
  `)) as unknown as { rows?: RawIndexRow[] };

  const rows = result.rows ?? [];
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    type: r.type,
    parent_slug: r.parent_slug,
    agent_abstract: r.agent_abstract,
  }));
}
