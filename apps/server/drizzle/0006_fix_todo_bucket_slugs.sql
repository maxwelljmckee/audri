-- Slice 7 follow-up: backfill todo-bucket slugs to path-style.
--
-- The seed initially created the todo buckets with bare slugs ('todo', 'done',
-- 'in-progress', 'archived') instead of the path-style slugs the spec calls
-- for ('todos/todo', etc.). Server + worker code assumes path-style, so any
-- pre-existing user can't have research tasks spawned (the lookup fails).
--
-- Backfill: rename only rows that are direct children of the user's `todos`
-- root page AND have a bare bucket slug. Safe + idempotent.

UPDATE "wiki_pages" AS bucket
SET slug = 'todos/' || bucket.slug,
    updated_at = now()
FROM "wiki_pages" AS root
WHERE bucket.parent_page_id = root.id
  AND bucket.user_id = root.user_id
  AND bucket.scope = 'user'
  AND root.scope = 'user'
  AND root.slug = 'todos'
  AND bucket.slug IN ('todo', 'in-progress', 'done', 'archived');
