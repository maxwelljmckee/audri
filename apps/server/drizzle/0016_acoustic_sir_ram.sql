CREATE TYPE "public"."chat_kind" AS ENUM('voice', 'text');--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD COLUMN "kind" "chat_kind" DEFAULT 'voice' NOT NULL;--> statement-breakpoint

-- ── call_transcripts: client-side sync for the Chat History UX surface ─────
-- The Chat History plugin reads from this table on mobile. Banner refactor
-- (Wiki overlay) also subscribes here for ingestion_status. Heavy / PII-y
-- columns (`tool_calls`, `pro_fan_out_response`, `dropped_turn_ids`) are
-- excluded via the publication column allowlist below.

ALTER TABLE "call_transcripts"
  ADD COLUMN IF NOT EXISTS "_deleted" boolean
  GENERATED ALWAYS AS (false) STORED;--> statement-breakpoint

ALTER TABLE "call_transcripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Drop-then-create pattern keeps this migration idempotent across retries
-- (e.g. partial-apply followed by re-run). Postgres has no
-- `CREATE POLICY IF NOT EXISTS`; drop+create is the canonical workaround.
DROP POLICY IF EXISTS "call_transcripts_select_own" ON "call_transcripts";--> statement-breakpoint
CREATE POLICY "call_transcripts_select_own"
  ON "call_transcripts"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

ALTER TABLE "call_transcripts" REPLICA IDENTITY FULL;--> statement-breakpoint

-- Column allowlist on the publication keeps `tool_calls`, `pro_fan_out_response`,
-- and `dropped_turn_ids` off the realtime wire. If realtime ever needs an
-- unlisted column, ADD it to the allowlist explicitly.
--
-- Note: `_deleted` is intentionally NOT in the column list. Postgres rejects
-- generated columns in publication column lists (error 42P10:
-- "cannot use generated column in publication column list"). The column
-- exists on the table for rxdb-supabase's tombstone-detection on the SELECT
-- (REST) side; it doesn't need to be in realtime events because its value
-- is a constant `false` (no soft-deletes on call_transcripts).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'call_transcripts'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.call_transcripts (id, user_id, agent_id, session_id, call_type, kind, title, summary, started_at, ended_at, content, cancelled, end_reason, ingestion_status, ingestion_error, created_at)';
  END IF;
END $$;--> statement-breakpoint

-- ── wiki_section_transcripts: synced for Chat History cross-references ─────
-- The Chat detail view shows "sections this chat produced" by reading the
-- inverse of this junction. Mobile gets just-the-junction (lightweight rows;
-- section content stays in the existing wiki_sections sync).

ALTER TABLE "wiki_section_transcripts"
  ADD COLUMN IF NOT EXISTS "_deleted" boolean
  GENERATED ALWAYS AS (false) STORED;--> statement-breakpoint

ALTER TABLE "wiki_section_transcripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Junction has no user_id directly; ownership flows through the section's
-- page. EXISTS subquery is fine — the planner uses the section + page
-- indexes already in place.
DROP POLICY IF EXISTS "wiki_section_transcripts_select_own" ON "wiki_section_transcripts";--> statement-breakpoint
CREATE POLICY "wiki_section_transcripts_select_own"
  ON "wiki_section_transcripts"
  FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM wiki_sections ws
    JOIN wiki_pages wp ON wp.id = ws.page_id
    WHERE ws.id = wiki_section_transcripts.section_id
    AND wp.user_id = auth.uid()
  ));--> statement-breakpoint

ALTER TABLE "wiki_section_transcripts" REPLICA IDENTITY FULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'wiki_section_transcripts'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.wiki_section_transcripts';
  END IF;
END $$;