-- v0.3.0 url_sources substrate (Storage plugin URL-ingestion path).
--
-- New tables:
--   - url_sources — URLs the user wants ingested into their wiki.
--     Server fetches the URL + extracts main content into
--     extracted_text. v0.3.0 supports `kind`:
--       - 'web_article' — Mozilla Readability extraction from HTML
--       - 'pdf' — pdf-parse extraction from application/pdf bytes
--       - 'reddit_thread' — public .json API extraction from Reddit URLs
--     Future kinds (youtube_video, twitter_thread, etc.) extend the
--     enum + add new extractor functions.
--   - url_source_attachments — per-attachment lifecycle, Path B
--     junction pattern. Multi-attach: one URL can fold into multiple
--     wiki subtrees over time.
--   - wiki_section_url_sources — cites a wiki section back to the
--     contributing URL source. Parallel to wiki_section_uploads.
--     Distinct from wiki_section_urls (live-call grounding; no FK).
--
-- RLS + realtime publication added below. No Supabase Storage bucket —
-- URLs are fetched server-side; nothing is stored in object storage.

CREATE TYPE "public"."url_source_extraction_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."url_source_kind" AS ENUM('web_article', 'pdf', 'reddit_thread');--> statement-breakpoint
CREATE TABLE "url_source_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url_source_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"status" "ingestion_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "url_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"url" text NOT NULL,
	"fetched_url" text,
	"kind" "url_source_kind" DEFAULT 'web_article' NOT NULL,
	"title" text,
	"site_name" text,
	"byline" text,
	"folder_path" text,
	"extraction_status" "url_source_extraction_status" DEFAULT 'pending' NOT NULL,
	"extracted_text" text,
	"extraction_error" text,
	"fetched_at" timestamp with time zone,
	"extracted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wiki_section_url_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"url_source_id" uuid NOT NULL,
	"snippet" text NOT NULL,
	"cited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "url_source_attachments" ADD CONSTRAINT "url_source_attachments_url_source_id_url_sources_id_fk" FOREIGN KEY ("url_source_id") REFERENCES "public"."url_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "url_source_attachments" ADD CONSTRAINT "url_source_attachments_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "url_sources" ADD CONSTRAINT "url_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_section_url_sources" ADD CONSTRAINT "wiki_section_url_sources_section_id_wiki_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."wiki_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_section_url_sources" ADD CONSTRAINT "wiki_section_url_sources_url_source_id_url_sources_id_fk" FOREIGN KEY ("url_source_id") REFERENCES "public"."url_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "url_source_attachments_source_page_unique" ON "url_source_attachments" USING btree ("url_source_id","page_id");--> statement-breakpoint
CREATE INDEX "url_source_attachments_source_idx" ON "url_source_attachments" USING btree ("url_source_id");--> statement-breakpoint
CREATE INDEX "url_source_attachments_page_idx" ON "url_source_attachments" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "url_sources_user_created_idx" ON "url_sources" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "url_sources_user_extraction_idx" ON "url_sources" USING btree ("user_id","extraction_status") WHERE tombstoned_at IS NULL;--> statement-breakpoint
CREATE INDEX "wiki_section_url_sources_section_idx" ON "wiki_section_url_sources" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "wiki_section_url_sources_source_idx" ON "wiki_section_url_sources" USING btree ("url_source_id");--> statement-breakpoint

-- ── _deleted generated column for rxdb-supabase ───────────────────────────
ALTER TABLE "url_sources"
  ADD COLUMN IF NOT EXISTS "_deleted" boolean
  GENERATED ALWAYS AS (tombstoned_at IS NOT NULL) STORED;--> statement-breakpoint

-- ── url_sources RLS ───────────────────────────────────────────────────────
ALTER TABLE "url_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "url_sources_select_own"
  ON "url_sources"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "url_sources_insert_own"
  ON "url_sources"
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "url_sources_update_own"
  ON "url_sources"
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint

-- ── url_source_attachments RLS ────────────────────────────────────────────
ALTER TABLE "url_source_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "url_source_attachments_select_own"
  ON "url_source_attachments"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "url_sources" u
      WHERE u.id = "url_source_attachments".url_source_id
        AND u.user_id = auth.uid()
    )
  );--> statement-breakpoint

-- ── wiki_section_url_sources RLS ──────────────────────────────────────────
ALTER TABLE "wiki_section_url_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "wiki_section_url_sources_select_own"
  ON "wiki_section_url_sources"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "url_sources" u
      WHERE u.id = "wiki_section_url_sources".url_source_id
        AND u.user_id = auth.uid()
    )
  );--> statement-breakpoint

-- ── Realtime publication enrollment ───────────────────────────────────────
ALTER TABLE "url_sources" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "url_source_attachments" REPLICA IDENTITY FULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'url_sources'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.url_sources';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'url_source_attachments'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.url_source_attachments';
  END IF;
END $$;
