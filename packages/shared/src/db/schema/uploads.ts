// Uploads — files (PDF / markdown / plain text / DOCX, with image +
// audio reserved for future kinds) that feed the existing ingestion
// fan-out as first-class sources alongside call transcripts.
// Substrate for v0.3.0 C4 Storage plugin + B2.27.
//
// Naming: table is `uploads` (the user mental model is "files I
// uploaded"); plugin tile + module are `Storage`; Supabase Storage
// bucket is `audri_storage`. URL ingestion is a separate concern
// (`url_sources` table — different lifecycle).
//
// Lifecycle:
//   1. POST /uploads (server) — inserts row with
//      extraction_status='awaiting_upload', returns signed Storage URL.
//   2. Client PUTs the file to the signed URL.
//   3. POST /uploads/:id/finalize — server flips to
//      extraction_status='pending', enqueues `extract_upload` graphile
//      job; worker downloads from Storage, runs per-kind extractor,
//      writes `extracted_text` + flips status to 'succeeded'/'failed'.
//      **Extraction stops here.** No automatic ingestion.
//   4. POST /uploads/:id/ingest — user explicitly attaches the upload
//      to a specific wiki page. Creates an `upload_attachments` row,
//      enqueues `ingestion_upload` subtree-scoped to that page. One
//      upload can be attached to N pages over time (different
//      contextual relevance to different subtrees); each attachment
//      produces its own source page + concept writes within that
//      subtree.
//
// Why per-attachment tracking (vs. a status field on uploads): a doc
// can legitimately ingest into multiple subtrees (decision-theory
// paper relevant to both projects/consensus AND profile/interests/
// decision-theory). The attachment is the unit of ingestion lifecycle.

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import {
  ingestionStatusEnum,
  uploadExtractionStatusEnum,
  uploadKindEnum,
} from './enums.js';
import { wikiPages, wikiSections } from './wiki.js';

export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    kind: uploadKindEnum('kind').notNull(),
    originalFilename: text('original_filename').notNull(),
    // Supabase Storage object path. Convention: '<user_id>/<upload_id>/<filename>'
    // — embeds the upload id so re-uploading a file with the same name
    // doesn't collide and the auth.uid()-prefix Storage RLS policy can
    // resolve ownership from the path alone.
    storagePath: text('storage_path').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),

    // ── Storage tile organization ────────────────────────────────
    // Pure-organization folder path for the Storage tile UI, e.g.
    // "/research/2026-papers/". Denormalized — folders are implicit
    // (any path string that appears here defines a folder). v0.3.0
    // keeps folders metadata-free; a later pass can promote to a
    // separate `upload_folders` table if folder-level metadata (color,
    // icon, soft-delete) becomes necessary. Null = root.
    folderPath: text('folder_path'),

    // ── Extraction stage ─────────────────────────────────────────
    // Status of getting raw text out of the file. Per-upload; not
    // per-attachment, since extraction only happens once.
    extractionStatus: uploadExtractionStatusEnum('extraction_status')
      .notNull()
      .default('awaiting_upload'),
    extractedText: text('extracted_text'),
    extractionError: text('extraction_error'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),

    // Ingestion status lives on upload_attachments (per-attachment)
    // — see below. An upload can have 0..N attachments; "unused"
    // = NOT EXISTS any attachment.

    // ── Bookkeeping ──────────────────────────────────────────────
    // Set when client POSTs /finalize confirming the file landed in
    // Storage. Null until then. NOT createdAt — that's the row insert.
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (t) => ({
    userCreatedIdx: index('uploads_user_created_idx').on(t.userId, t.createdAt.desc()),
    userExtractionIdx: index('uploads_user_extraction_idx')
      .on(t.userId, t.extractionStatus)
      .where(sql`tombstoned_at IS NULL`),
  }),
);

// ── upload_attachments ────────────────────────────────────────────────────
// Per-attachment lifecycle. Each row = "user attached this upload to
// this wiki page, ingest the doc into that page's subtree." Allows
// multi-ingest: a doc can be folded into multiple subtrees over time.
//
// Unique on (upload_id, page_id) — prevents accidental double-fire to
// the same scope. Retry-after-failure flow: controller mutates the
// existing row (resets status + re-enqueues) rather than inserting a
// duplicate.
export const uploadAttachments = pgTable(
  'upload_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => uploads.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    // Reuses ingestionStatusEnum — same lifecycle vocabulary applies.
    // 'skipped_over_cap' applies the same way (over-cap → no fan-out;
    // user re-fires after raising the cap).
    status: ingestionStatusEnum('status').notNull().default('pending'),
    error: text('error'),
    attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    uploadPageUnique: uniqueIndex('upload_attachments_upload_page_unique')
      .on(t.uploadId, t.pageId),
    uploadIdx: index('upload_attachments_upload_idx').on(t.uploadId),
    pageIdx: index('upload_attachments_page_idx').on(t.pageId),
  }),
);

// Junction — mirrors wiki_section_transcripts. Cites a wiki section
// back to the source upload that contributed to it. snippet stores
// the relevant excerpt for UX display; no turn_id equivalent since
// uploads aren't turn-structured (a future "location" / page-number
// column can land alongside the Storage detail UI if needed).
export const wikiSectionUploads = pgTable(
  'wiki_section_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => wikiSections.id, { onDelete: 'cascade' }),
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => uploads.id, { onDelete: 'cascade' }),
    snippet: text('snippet').notNull(),
    citedAt: timestamp('cited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sectionIdx: index('wiki_section_uploads_section_idx').on(t.sectionId),
    uploadIdx: index('wiki_section_uploads_upload_idx').on(t.uploadId),
  }),
);
