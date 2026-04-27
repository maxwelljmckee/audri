import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { callTranscripts } from './calls.js';
import { wikiPages, wikiSections } from './wiki.js';

export const wikiSectionTranscripts = pgTable(
  'wiki_section_transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => wikiSections.id, { onDelete: 'cascade' }),
    transcriptId: uuid('transcript_id')
      .notNull()
      .references(() => callTranscripts.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull(),
    snippet: text('snippet').notNull(),
    citedAt: timestamp('cited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sectionIdx: index('wiki_section_transcripts_section_idx').on(t.sectionId),
    transcriptIdx: index('wiki_section_transcripts_transcript_idx').on(t.transcriptId),
  }),
);

export const wikiSectionUrls = pgTable(
  'wiki_section_urls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => wikiSections.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    snippet: text('snippet').notNull(),
    citedAt: timestamp('cited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sectionIdx: index('wiki_section_urls_section_idx').on(t.sectionId),
    urlIdx: index('wiki_section_urls_url_idx').on(t.url),
  }),
);

export const wikiSectionAncestors = pgTable(
  'wiki_section_ancestors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => wikiSections.id, { onDelete: 'cascade' }),
    ancestorPageId: uuid('ancestor_page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    snippet: text('snippet').notNull(),
    citedAt: timestamp('cited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sectionIdx: index('wiki_section_ancestors_section_idx').on(t.sectionId),
    ancestorIdx: index('wiki_section_ancestors_ancestor_idx').on(t.ancestorPageId),
  }),
);
