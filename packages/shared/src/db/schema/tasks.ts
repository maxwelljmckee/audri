import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import { agentTaskKindEnum, agentTaskStatusEnum, artifactKindEnum } from './enums.js';
import { agents } from './identity.js';
import { wikiPages } from './wiki.js';

export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    todoPageId: uuid('todo_page_id')
      .notNull()
      .references(() => wikiPages.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
    kind: agentTaskKindEnum('kind').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    status: agentTaskStatusEnum('status').notNull().default('pending'),
    priority: integer('priority').notNull().default(5),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    retryCount: integer('retry_count').notNull().default(0),
    lastError: text('last_error'),
    graphileJobId: text('graphile_job_id'),
    resultArtifactKind: artifactKindEnum('result_artifact_kind'),
    resultArtifactId: uuid('result_artifact_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userStatusScheduledIdx: index('agent_tasks_user_status_scheduled_idx').on(
      t.userId,
      t.status,
      t.scheduledFor,
    ),
    graphileJobIdx: index('agent_tasks_graphile_job_idx').on(t.graphileJobId),
    todoPageIdx: index('agent_tasks_todo_page_idx').on(t.todoPageId),
    priorityCheck: check('agent_tasks_priority_check', sql`priority BETWEEN 0 AND 10`),
  }),
);
