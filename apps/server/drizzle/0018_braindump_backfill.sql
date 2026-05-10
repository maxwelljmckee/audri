-- Backfills for the v0.2.0 top-level page taxonomy. Lives in its own
-- migration because Postgres requires the new 'braindump' enum value (added
-- in 0017) to be committed before it can be USED in `'braindump'::page_type`
-- casts. Splitting also keeps the abstract-update statements idempotent
-- across re-runs.

-- ── Top-level page subtitle (`abstract`) backfill ───────────────────────────
-- New users get these via seed.service.ts; existing users need backfill.
-- WHERE clauses keep this idempotent — only touches rows with NULL/empty
-- abstracts on the seeded buckets.

UPDATE "wiki_pages"
SET "abstract" = 'Everything that makes you, you'
WHERE "scope" = 'user'
  AND "slug" = 'profile'
  AND "tombstoned_at" IS NULL
  AND ("abstract" IS NULL OR "abstract" = '');--> statement-breakpoint

UPDATE "wiki_pages"
SET "abstract" = 'Things you''re working on'
WHERE "scope" = 'user'
  AND "slug" = 'projects'
  AND "tombstoned_at" IS NULL
  AND ("abstract" IS NULL OR "abstract" = '');--> statement-breakpoint

-- Tighten existing top-level agent_abstracts so the model preload reflects
-- the v0.2 routing taxonomy (profile = evergreen-about-you, projects =
-- active work, braindump = transient/exploratory). Only touches the seeded
-- root pages.
UPDATE "wiki_pages"
SET "agent_abstract" =
  'The user''s profile — evergreen content about who they are, what matters to them, what defines them. Seven askable canonical sub-pages: goals, life-history, health, work, interests, relationships, preferences. Emergent: values, psychology.'
WHERE "scope" = 'user' AND "slug" = 'profile' AND "tombstoned_at" IS NULL;--> statement-breakpoint

UPDATE "wiki_pages"
SET "agent_abstract" =
  'The user''s active projects. Each project lives as a direct child page; sub-topics nest under their parent project. Active work — distinct from braindump (unstructured exploration) or profile (evergreen about-the-user).'
WHERE "scope" = 'user' AND "slug" = 'projects' AND "tombstoned_at" IS NULL;--> statement-breakpoint

-- ── Braindump page backfill for existing users ─────────────────────────────
-- New users get this via seed.service.ts. Existing users need the page
-- inserted manually so they have all four top-level buckets. Inserts one
-- row per user that has a profile page but no braindump page.

INSERT INTO "wiki_pages" ("user_id", "scope", "type", "slug", "title", "agent_abstract", "abstract")
SELECT DISTINCT
  wp."user_id",
  'user'::wiki_scope,
  'braindump'::page_type,
  'braindump',
  'Braindump',
  'Unstructured/transient/exploratory thoughts. Catchall for stuff that isn''t yet a project, isn''t evergreen-about-the-user, and isn''t a task. Sub-pages emerge as content clusters.',
  'Unstructured notes and ideas'
FROM "wiki_pages" wp
WHERE wp."scope" = 'user'
  AND wp."slug" = 'profile'
  AND wp."tombstoned_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "wiki_pages" existing
    WHERE existing."user_id" = wp."user_id"
      AND existing."scope" = 'user'
      AND existing."slug" = 'braindump'
  );
