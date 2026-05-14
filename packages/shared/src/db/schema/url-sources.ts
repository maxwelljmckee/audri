// URL sources — full-document URLs the user wants ingested into their
// wiki. Different lifecycle from uploads: server fetches the URL +
// extracts main content (Mozilla Readability) rather than the client
// uploading a file. Same Path B junction pattern for attachments —
// one URL can be ingested into multiple wiki subtrees over time.
//
// Distinct from `wiki_section_urls` (which exists already): that table
// captures live-call URL grounding — Audri citing a web source via
// googleSearch during a transcript. Different semantic, ephemeral
// citation only, no fetched document.
//
// v0.3.0 scope: text/html only. PDFs-at-URL / YouTube transcripts /
// Twitter threads / RSS items are backlog.
//
// Lifecycle:
//   1. POST /urls — server inserts row (extraction_status='pending'),
//      enqueues `fetch_url`.
//   2. fetch_url (worker) — HTTP GET + Readability extraction; writes
//      extracted_text + title + site_name + byline; flips status to
//      'succeeded' or 'failed'.
//   3. POST /urls/:id/ingest — user explicitly attaches the URL to a
//      wiki page. Inserts a `url_source_attachments` row + enqueues
//      `ingestion_url_source` subtree-scoped to that page. One URL can
//      have N attachments over time.

import { sql } from 'drizzle-orm';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import {
  ingestionStatusEnum,
  urlSourceExtractionStatusEnum,
  urlSourceKindEnum,
} from './enums.js';
import { wikiPages, wikiSections } from './wiki.js';

export const urlSources = pgTable(
  'url_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),

    // Original URL as the user provided it (or as a share extension
    // posted it). Stored as-is for audit; the fetcher follows
    // redirects naturally + may end up reading content from a
    // different effective URL.
    url: text('url').notNull(),
    // Final URL after redirects. Useful for canonical-link display.
    // Null until fetched.
    fetchedUrl: text('fetched_url'),

    // Resolved kind after fetch. Inserted with default 'web_article';
    // the worker may update to 'pdf' (content-type), 'reddit_thread'
    // (URL pattern), etc. Drives Storage tile rendering + which
    // section structure Pro emits in fan-out.
    kind: urlSourceKindEnum('kind').notNull().default('web_article'),

    // Extracted metadata.
    title: text('title'),
    siteName: text('site_name'),
    byline: text('byline'),

    // Storage tile organization (same pattern as uploads). The Storage
    // plugin may surface URLs alongside files in the same browseable
    // filesystem; folder_path is the per-row position. Null = root.
    folderPath: text('folder_path'),

    // ── Extraction stage ─────────────────────────────────────────
    extractionStatus: urlSourceExtractionStatusEnum('extraction_status')
      .notNull()
      .default('pending'),
    extractedText: text('extracted_text'),
    extractionError: text('extraction_error'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),

    // Ingestion status lives on url_source_attachments (per-attachment)
    // — see below.

    // ── Bookkeeping ──────────────────────────────────────────────
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (t) => ({
    userCreatedIdx: index('url_sources_user_created_idx').on(t.userId, t.createdAt.desc()),
    userExtractionIdx: index('url_sources_user_extraction_idx')
      .on(t.userId, t.extractionStatus)
      .where(sql`tombstoned_at IS NULL`),
  }),
);

// Per-attachment lifecycle — mirrors upload_attachments. Allows
// multi-ingest: one URL can fold into multiple subtrees over time.
export const urlSourceAttachments = pgTable(
  'url_source_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    urlSourceId: uuid('url_source_id')
      .notNull()
      .references(() => urlSources.id, { onDelete: 'cascade' }),
    pageId: uuid('page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    status: ingestionStatusEnum('status').notNull().default('pending'),
    error: text('error'),
    attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    sourcePageUnique: uniqueIndex('url_source_attachments_source_page_unique')
      .on(t.urlSourceId, t.pageId),
    sourceIdx: index('url_source_attachments_source_idx').on(t.urlSourceId),
    pageIdx: index('url_source_attachments_page_idx').on(t.pageId),
  }),
);

// Junction — cites wiki sections back to fetched URL sources. Parallel
// to wiki_section_uploads. Distinct from wiki_section_urls (live-call
// grounding citations; no FK to a fetched document).
export const wikiSectionUrlSources = pgTable(
  'wiki_section_url_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => wikiSections.id, { onDelete: 'cascade' }),
    urlSourceId: uuid('url_source_id')
      .notNull()
      .references(() => urlSources.id, { onDelete: 'cascade' }),
    snippet: text('snippet').notNull(),
    citedAt: timestamp('cited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sectionIdx: index('wiki_section_url_sources_section_idx').on(t.sectionId),
    sourceIdx: index('wiki_section_url_sources_source_idx').on(t.urlSourceId),
  }),
);
