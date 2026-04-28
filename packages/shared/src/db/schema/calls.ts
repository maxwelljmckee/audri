import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import { callTypeEnum, endReasonEnum, ingestionStatusEnum } from './enums.js';
import { agents } from './identity.js';

export const callTranscripts = pgTable(
  'call_transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    sessionId: text('session_id').notNull(),
    callType: callTypeEnum('call_type').notNull().default('generic'),
    title: text('title'),
    summary: text('summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    content: jsonb('content').notNull().default(sql`'[]'::jsonb`),
    toolCalls: jsonb('tool_calls'),
    droppedTurnIds: text('dropped_turn_ids')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    cancelled: boolean('cancelled').notNull().default(false),
    endReason: endReasonEnum('end_reason'),
    ingestionStatus: ingestionStatusEnum('ingestion_status').notNull().default('pending'),
    ingestionError: text('ingestion_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionUnique: uniqueIndex('call_transcripts_session_idx').on(t.sessionId),
    userStartedIdx: index('call_transcripts_user_started_idx').on(t.userId, t.startedAt.desc()),
    userAgentStartedIdx: index('call_transcripts_user_agent_started_idx').on(
      t.userId,
      t.agentId,
      t.startedAt.desc(),
    ),
  }),
);
