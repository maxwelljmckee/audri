import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import { callTranscripts } from './calls.js';
import { artifactKindEnum, usageEventKindEnum } from './enums.js';
import { agents } from './identity.js';
import { agentTasks } from './tasks.js';

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
    agentTasksId: uuid('agent_tasks_id').references(() => agentTasks.id, {
      onDelete: 'set null',
    }),
    eventKind: usageEventKindEnum('event_kind').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    model: text('model').notNull(),
    costCents: numeric('cost_cents', { precision: 12, scale: 4 }).notNull().default('0'),
    artifactKind: artifactKindEnum('artifact_kind'),
    artifactId: uuid('artifact_id'),
    callTranscriptId: uuid('call_transcript_id').references(() => callTranscripts.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCreatedIdx: index('usage_events_user_created_idx').on(t.userId, t.createdAt.desc()),
    userKindCreatedIdx: index('usage_events_user_kind_created_idx').on(
      t.userId,
      t.eventKind,
      t.createdAt.desc(),
    ),
    agentTasksIdx: index('usage_events_agent_tasks_idx').on(t.agentTasksId),
    tokensCheck: check(
      'usage_events_tokens_check',
      sql`input_tokens >= 0 AND output_tokens >= 0 AND cached_tokens >= 0`,
    ),
  }),
);
