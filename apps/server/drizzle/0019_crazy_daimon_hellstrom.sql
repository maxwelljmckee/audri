CREATE TYPE "public"."todo_status" AS ENUM('todo', 'in-progress', 'done', 'archived');--> statement-breakpoint
CREATE TABLE "todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"parent_page_id" uuid,
	"status" "todo_status" DEFAULT 'todo' NOT NULL,
	"due_date" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_parent_page_id_wiki_pages_id_fk" FOREIGN KEY ("parent_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "todos_page_idx" ON "todos" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "todos_user_status_idx" ON "todos" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "todos_user_parent_idx" ON "todos" USING btree ("user_id","parent_page_id");--> statement-breakpoint

-- ── RLS + realtime sync (todos sidecar is mobile-readable + mobile-writable) ─
-- Mobile reads all of the user's todos to render the swimlane UX; mobile
-- updates `status` (check-off / archive) and `parent_page_id` (re-associate).
-- Inserts go through the wiki ingestion + manual-create paths server-side.

ALTER TABLE "todos"
  ADD COLUMN IF NOT EXISTS "_deleted" boolean
  GENERATED ALWAYS AS (false) STORED;--> statement-breakpoint

ALTER TABLE "todos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS "todos_select_own" ON "todos";--> statement-breakpoint
CREATE POLICY "todos_select_own"
  ON "todos"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

DROP POLICY IF EXISTS "todos_update_own" ON "todos";--> statement-breakpoint
CREATE POLICY "todos_update_own"
  ON "todos"
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint

ALTER TABLE "todos" REPLICA IDENTITY FULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'todos'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.todos';
  END IF;
END $$;--> statement-breakpoint

-- ── Backfill: insert sidecar rows for every existing todo wiki page ────────
-- Status is derived from the current parent_page_id slug:
--   todos/todo          → 'todo'
--   todos/in-progress   → 'in-progress'
--   todos/done          → 'done'
--   todos/archived      → 'archived'
-- parent_page_id starts NULL — there's no project context to derive from
-- existing todos. Users can re-associate manually via the Todos plugin.

INSERT INTO "todos" ("user_id", "page_id", "status", "completed_at")
SELECT
  todo_page."user_id",
  todo_page."id",
  CASE bucket."slug"
    WHEN 'todos/todo' THEN 'todo'::todo_status
    WHEN 'todos/in-progress' THEN 'in-progress'::todo_status
    WHEN 'todos/done' THEN 'done'::todo_status
    WHEN 'todos/archived' THEN 'archived'::todo_status
    ELSE 'todo'::todo_status
  END,
  CASE bucket."slug"
    WHEN 'todos/done' THEN now()
    WHEN 'todos/archived' THEN now()
    ELSE NULL
  END
FROM "wiki_pages" todo_page
LEFT JOIN "wiki_pages" bucket ON bucket."id" = todo_page."parent_page_id"
WHERE todo_page."type" = 'todo'
  AND todo_page."scope" = 'user'
  AND todo_page."tombstoned_at" IS NULL
  AND todo_page."slug" NOT IN ('todos', 'todos/todo', 'todos/in-progress', 'todos/done', 'todos/archived')
  AND NOT EXISTS (
    SELECT 1 FROM "todos" existing WHERE existing."page_id" = todo_page."id"
  );--> statement-breakpoint

-- ── Reparent existing todo wiki rows to the `todos` root ───────────────────
-- Status is now in the sidecar; the four status bucket pages no longer
-- carry meaning. Move all individual todos to be direct children of the
-- `todos` root, then tombstone the bucket pages below.

UPDATE "wiki_pages" individual_todo
SET "parent_page_id" = (
      SELECT "id" FROM "wiki_pages" todos_root
      WHERE todos_root."user_id" = individual_todo."user_id"
        AND todos_root."scope" = 'user'
        AND todos_root."slug" = 'todos'
      LIMIT 1
    ),
    "updated_at" = now()
WHERE individual_todo."type" = 'todo'
  AND individual_todo."scope" = 'user'
  AND individual_todo."tombstoned_at" IS NULL
  AND individual_todo."slug" NOT IN ('todos', 'todos/todo', 'todos/in-progress', 'todos/done', 'todos/archived');--> statement-breakpoint

-- ── Tombstone the four status bucket pages ─────────────────────────────────
-- They're no longer load-bearing — sidecar owns status. Tombstone (don't
-- DELETE) so foreign-key references from history / log rows stay intact.

UPDATE "wiki_pages"
SET "tombstoned_at" = now(), "updated_at" = now()
WHERE "scope" = 'user'
  AND "slug" IN ('todos/todo', 'todos/in-progress', 'todos/done', 'todos/archived')
  AND "tombstoned_at" IS NULL;