import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import { editedByEnum, pageTypeEnum, wikiLogKindEnum, wikiScopeEnum } from './enums.js';
import { agents } from './identity.js';

export const wikiPages = pgTable(
  'wiki_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    scope: wikiScopeEnum('scope').notNull(),
    type: pageTypeEnum('type').notNull(),
    slug: text('slug').notNull(),
    parentPageId: uuid('parent_page_id').references((): AnyPgColumn => wikiPages.id, {
      onDelete: 'restrict',
    }),
    title: text('title').notNull(),
    agentAbstract: text('agent_abstract').notNull(),
    abstract: text('abstract'),
    frontmatter: jsonb('frontmatter').notNull().default(sql`'{}'::jsonb`),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (t) => ({
    userScopeSlugUnique: uniqueIndex('wiki_pages_user_scope_slug_idx').on(
      t.userId,
      t.scope,
      t.slug,
    ),
    userScopeParentTitleUnique: uniqueIndex('wiki_pages_user_scope_parent_title_idx').on(
      t.userId,
      t.scope,
      t.parentPageId,
      t.title,
    ),
    userScopeTypeIdx: index('wiki_pages_user_scope_type_idx').on(t.userId, t.scope, t.type),
    userScopeAgentParentIdx: index('wiki_pages_user_scope_agent_parent_idx').on(
      t.userId,
      t.scope,
      t.agentId,
      t.parentPageId,
    ),
    parentLiveIdx: index('wiki_pages_parent_live_idx')
      .on(t.parentPageId)
      .where(sql`tombstoned_at IS NULL`),
    frontmatterGin: index('wiki_pages_frontmatter_gin')
      .using('gin', sql`frontmatter jsonb_path_ops`),
    scopeAgentCheck: check(
      'wiki_pages_scope_agent_check',
      sql`(scope = 'user' AND agent_id IS NULL) OR (scope = 'agent' AND agent_id IS NOT NULL)`,
    ),
  }),
);

export const wikiSections = pgTable(
  'wiki_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    title: text('title'),
    content: text('content').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (t) => ({
    pageTitleUnique: uniqueIndex('wiki_sections_page_title_idx')
      .on(t.pageId, t.title)
      .where(sql`title IS NOT NULL`),
    pageOrderIdx: index('wiki_sections_page_order_idx').on(t.pageId, t.sortOrder),
    contentFts: index('wiki_sections_content_fts').using(
      'gin',
      sql`to_tsvector('english', content)`,
    ),
  }),
);

export const wikiSectionHistory = pgTable(
  'wiki_section_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => wikiSections.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    editedBy: editedByEnum('edited_by').notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sectionEditedAtIdx: index('wiki_section_history_section_edited_at_idx').on(
      t.sectionId,
      t.editedAt.desc(),
    ),
  }),
);

export const wikiLog = pgTable(
  'wiki_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    kind: wikiLogKindEnum('kind').notNull(),
    ref: jsonb('ref').notNull().default(sql`'{}'::jsonb`),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('wiki_log_user_created_idx').on(t.userId, t.createdAt.desc()),
  }),
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userNameUnique: uniqueIndex('tags_user_name_idx').on(t.userId, t.name),
  }),
);

export const wikiPageTags = pgTable(
  'wiki_page_tags',
  {
    pageId: uuid('page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.pageId, t.tagId] }),
    tagIdx: index('wiki_page_tags_tag_idx').on(t.tagId),
  }),
);
