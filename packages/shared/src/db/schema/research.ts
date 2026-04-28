import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import { agentTasks } from './tasks.js';
import { wikiPages } from './wiki.js';

export const researchOutputs = pgTable(
  'research_outputs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    agentTasksId: uuid('agent_tasks_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'restrict' }),
    query: text('query').notNull(),
    summary: text('summary').notNull(),
    findings: jsonb('findings').notNull(),
    citations: jsonb('citations').notNull().default(sql`'[]'::jsonb`),
    followUpQuestions: text('follow_up_questions')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    notesForUser: text('notes_for_user'),
    modelUsed: text('model_used').notNull(),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (t) => ({
    userGeneratedIdx: index('research_outputs_user_generated_idx').on(
      t.userId,
      t.generatedAt.desc(),
    ),
    agentTasksIdx: index('research_outputs_agent_tasks_idx').on(t.agentTasksId),
  }),
);

export const researchOutputSources = pgTable(
  'research_output_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    researchOutputId: uuid('research_output_id')
      .notNull()
      .references(() => researchOutputs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    snippet: text('snippet').notNull(),
    citationIndex: integer('citation_index').notNull(),
    citedAt: timestamp('cited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    researchIdx: index('research_output_sources_research_idx').on(t.researchOutputId),
    urlIdx: index('research_output_sources_url_idx').on(t.url),
  }),
);

export const researchOutputAncestors = pgTable(
  'research_output_ancestors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    researchOutputId: uuid('research_output_id')
      .notNull()
      .references(() => researchOutputs.id, { onDelete: 'cascade' }),
    ancestorPageId: uuid('ancestor_page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'cascade' }),
    snippet: text('snippet').notNull(),
    citedAt: timestamp('cited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    researchIdx: index('research_output_ancestors_research_idx').on(t.researchOutputId),
    ancestorIdx: index('research_output_ancestors_ancestor_idx').on(t.ancestorPageId),
  }),
);
