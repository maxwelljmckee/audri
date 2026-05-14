-- C4 / B2.27: uploads pipeline substrate (Storage plugin).
--
-- New tables:
--   - uploads — files uploaded via Storage tile (PDF/markdown/plain/DOCX
--     now; image + audio reserved as future kinds). Carries extraction
--     status; ingestion status moved to per-attachment rows.
--   - upload_attachments — per-attachment lifecycle. Each row = "user
--     attached this upload to this wiki page; ingest it into that
--     page's subtree." Allows multi-ingest: one doc can fold into
--     multiple subtrees over time (different contextual relevance to
--     different projects).
--   - wiki_section_uploads — junction mirroring
--     wiki_section_transcripts; cites a wiki section back to the
--     contributing upload.
--
-- Also configures:
--   - RLS so users only see their own uploads + attachments + cites.
--   - Realtime publication so the mobile Storage tile reflects state
--     changes live (RxDB sync) for both uploads and upload_attachments.
--   - Supabase Storage bucket 'audri_storage' (private) with RLS keyed
--     on the user_id-prefixed path convention.
--
-- Naming: table = `uploads`; module + UI tile = `Storage`; bucket =
-- `audri_storage`. URL ingestion is a separate concern (`url_sources`
-- table — different lifecycle, no Storage object).

CREATE TYPE "public"."upload_extraction_status" AS ENUM('awaiting_upload', 'pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."upload_kind" AS ENUM('pdf', 'markdown', 'plain', 'docx');--> statement-breakpoint
CREATE TABLE "upload_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"status" "ingestion_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "upload_kind" NOT NULL,
	"original_filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"folder_path" text,
	"extraction_status" "upload_extraction_status" DEFAULT 'awaiting_upload' NOT NULL,
	"extracted_text" text,
	"extraction_error" text,
	"extracted_at" timestamp with time zone,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wiki_section_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"section_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"snippet" text NOT NULL,
	"cited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_attachments" ADD CONSTRAINT "upload_attachments_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_attachments" ADD CONSTRAINT "upload_attachments_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_section_uploads" ADD CONSTRAINT "wiki_section_uploads_section_id_wiki_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."wiki_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_section_uploads" ADD CONSTRAINT "wiki_section_uploads_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_attachments_upload_page_unique" ON "upload_attachments" USING btree ("upload_id","page_id");--> statement-breakpoint
CREATE INDEX "upload_attachments_upload_idx" ON "upload_attachments" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "upload_attachments_page_idx" ON "upload_attachments" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "uploads_user_created_idx" ON "uploads" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "uploads_user_extraction_idx" ON "uploads" USING btree ("user_id","extraction_status") WHERE tombstoned_at IS NULL;--> statement-breakpoint
CREATE INDEX "wiki_section_uploads_section_idx" ON "wiki_section_uploads" USING btree ("section_id");--> statement-breakpoint
CREATE INDEX "wiki_section_uploads_upload_idx" ON "wiki_section_uploads" USING btree ("upload_id");--> statement-breakpoint

-- ── _deleted generated columns for rxdb-supabase ─────────────────────────
ALTER TABLE "uploads"
  ADD COLUMN IF NOT EXISTS "_deleted" boolean
  GENERATED ALWAYS AS (tombstoned_at IS NOT NULL) STORED;--> statement-breakpoint

-- ── uploads RLS ───────────────────────────────────────────────────────────
ALTER TABLE "uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "uploads_select_own"
  ON "uploads"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "uploads_insert_own"
  ON "uploads"
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "uploads_update_own"
  ON "uploads"
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint

-- ── upload_attachments RLS ────────────────────────────────────────────────
ALTER TABLE "upload_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "upload_attachments_select_own"
  ON "upload_attachments"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "uploads" u
      WHERE u.id = "upload_attachments".upload_id
        AND u.user_id = auth.uid()
    )
  );--> statement-breakpoint

-- ── wiki_section_uploads RLS ──────────────────────────────────────────────
ALTER TABLE "wiki_section_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "wiki_section_uploads_select_own"
  ON "wiki_section_uploads"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "uploads" u
      WHERE u.id = "wiki_section_uploads".upload_id
        AND u.user_id = auth.uid()
    )
  );--> statement-breakpoint

-- ── Realtime publication enrollment ───────────────────────────────────────
ALTER TABLE "uploads" REPLICA IDENTITY FULL;--> statement-breakpoint
ALTER TABLE "upload_attachments" REPLICA IDENTITY FULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'uploads'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.uploads';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'upload_attachments'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.upload_attachments';
  END IF;
END $$;--> statement-breakpoint

-- ── Supabase Storage bucket + policies ────────────────────────────────────
-- Private bucket (signed URLs only). Path convention:
--   <user_id>/<upload_id>/<filename>
-- Storage RLS extracts the first path segment via
-- storage.foldername(name)[1] and matches against auth.uid().

INSERT INTO storage.buckets (id, name, public)
VALUES ('audri_storage', 'audri_storage', false)
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

DROP POLICY IF EXISTS "audri_storage_select_own" ON storage.objects;--> statement-breakpoint
CREATE POLICY "audri_storage_select_own"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'audri_storage'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );--> statement-breakpoint

DROP POLICY IF EXISTS "audri_storage_insert_own" ON storage.objects;--> statement-breakpoint
CREATE POLICY "audri_storage_insert_own"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'audri_storage'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );--> statement-breakpoint

DROP POLICY IF EXISTS "audri_storage_update_own" ON storage.objects;--> statement-breakpoint
CREATE POLICY "audri_storage_update_own"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'audri_storage'
    AND auth.uid()::text = (storage.foldername(name))[1]
  )
  WITH CHECK (
    bucket_id = 'audri_storage'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );--> statement-breakpoint

DROP POLICY IF EXISTS "audri_storage_delete_own" ON storage.objects;--> statement-breakpoint
CREATE POLICY "audri_storage_delete_own"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'audri_storage'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
