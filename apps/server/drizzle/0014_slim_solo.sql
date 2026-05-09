CREATE TYPE "public"."agent_open_item_kind" AS ENUM('question', 'info_share');--> statement-breakpoint
CREATE TYPE "public"."agent_open_item_status" AS ENUM('pending', 'surfaced', 'answered', 'engaged', 'dismissed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('supported', 'contested', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."wiki_maturity" AS ENUM('stub', 'moderate', 'full');--> statement-breakpoint
CREATE TABLE "agent_open_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "agent_open_item_kind" NOT NULL,
	"topic" text NOT NULL,
	"body_text" text NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"status" "agent_open_item_status" DEFAULT 'pending' NOT NULL,
	"created_by_task_id" uuid,
	"cross_domain_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"surfaced_at" timestamp with time zone,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "extracted_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject_page_id" uuid NOT NULL,
	"wiki_section_id" uuid,
	"call_transcript_id" uuid,
	"claim_text" text NOT NULL,
	"status" "claim_status" DEFAULT 'supported' NOT NULL,
	"confidence" integer,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "person_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN "maturity" "wiki_maturity";--> statement-breakpoint
ALTER TABLE "agent_open_items" ADD CONSTRAINT "agent_open_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_open_items" ADD CONSTRAINT "agent_open_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_claims" ADD CONSTRAINT "extracted_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_claims" ADD CONSTRAINT "extracted_claims_subject_page_id_wiki_pages_id_fk" FOREIGN KEY ("subject_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_claims" ADD CONSTRAINT "extracted_claims_wiki_section_id_wiki_sections_id_fk" FOREIGN KEY ("wiki_section_id") REFERENCES "public"."wiki_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_claims" ADD CONSTRAINT "extracted_claims_call_transcript_id_call_transcripts_id_fk" FOREIGN KEY ("call_transcript_id") REFERENCES "public"."call_transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_open_items_agent_status_priority_idx" ON "agent_open_items" USING btree ("agent_id","status","priority");--> statement-breakpoint
CREATE INDEX "agent_open_items_status_created_idx" ON "agent_open_items" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "agent_open_items_user_idx" ON "agent_open_items" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "extracted_claims_user_subject_idx" ON "extracted_claims" USING btree ("user_id","subject_page_id");--> statement-breakpoint
CREATE INDEX "extracted_claims_section_idx" ON "extracted_claims" USING btree ("wiki_section_id");--> statement-breakpoint
CREATE INDEX "extracted_claims_transcript_idx" ON "extracted_claims" USING btree ("call_transcript_id");--> statement-breakpoint
CREATE INDEX "extracted_claims_status_refreshed_idx" ON "extracted_claims" USING btree ("status","last_refreshed_at");--> statement-breakpoint

-- ── agent_open_items: client-syncable per-persona queue ─────────────────────
-- Mirrors 0009_agent_tasks_rls_realtime.sql pattern. Mobile reads (Agents
-- tile) + writes (snooze/dismiss). Server (service_role) inserts via the
-- agent-scope ingestion fan-out (v0.2 item #4) and the manual-seed tooling
-- used during DP-7 Stage 2.

ALTER TABLE "agent_open_items"
  ADD COLUMN IF NOT EXISTS "_deleted" boolean
  GENERATED ALWAYS AS (false) STORED;--> statement-breakpoint

ALTER TABLE "agent_open_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "agent_open_items_select_own"
  ON "agent_open_items"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

-- UPDATE policy for snooze/dismiss. WITH CHECK clause re-validates the
-- post-update row so a malicious client can't re-parent the row to another
-- user via the update path.
CREATE POLICY "agent_open_items_update_own"
  ON "agent_open_items"
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint

ALTER TABLE "agent_open_items" REPLICA IDENTITY FULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'agent_open_items'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_open_items';
  END IF;
END $$;--> statement-breakpoint

-- ── extracted_claims: server-only audit trail ──────────────────────────────
-- RLS enabled defensively even though service_role bypasses it. No policies
-- defined for authenticated role — claims are not exposed to clients in v0.2.
-- (Future: a client-readable subset for surfacing claim provenance in the
-- Wiki UI; defer until that feature is scoped.)

ALTER TABLE "extracted_claims" ENABLE ROW LEVEL SECURITY;