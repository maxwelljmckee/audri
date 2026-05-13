// Automations primitive (v0.3.0 B1). Each row is a user-installed
// recurring agent_task spec: a schedule + payload + the kind of work to
// run when it fires. The dispatcher (apps/worker/src/tasks/dispatch-
// recurring.ts) sweeps for due rows and enqueues a regular agent_tasks
// row, which runs through the standard dispatch-agent-task.ts path
// (handler lookup, spend-cap gate, retry, etc.).
//
// Lifecycle:
//   - User toggles a suggested-default automation ON → INSERT row.
//     next_run_at computed from schedule at insert time.
//   - User edits cadence → UPDATE row. next_run_at recomputed.
//   - User pauses → UPDATE paused=true, next_run_at=NULL. Resumed by
//     toggling back; next_run_at recomputed.
//   - User toggles OFF → soft-delete (tombstoned_at = now()).
//
// Per-user jitter: the actual fire time is the nominal cron time PLUS
// a per-(user_id, automation_id)-stable hash offset within
// jitter_minutes. Spreads load across the service so 1000 users with
// "Daily Brief at 5am" don't all fire at 05:00:00.

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { authUsers } from './_auth.js';
import { agentTaskKindEnum } from './enums.js';
import { agents } from './identity.js';
import { agentTasks } from './tasks.js';

export const recurringAgentTasks = pgTable(
  'recurring_agent_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    // The agent this automation runs against for per-agent kinds (e.g.
    // Dreaming-of-Assistant). NULL for app-level automations (Daily
    // Recap) that span the whole user surface, not a specific persona.
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    // The plugin kind whose handler runs when this automation fires.
    // Keys into pluginRegistry; matches the agent_tasks.kind enum so
    // a row from this table can be cleanly converted to an agent_tasks
    // row by the dispatcher.
    kind: agentTaskKindEnum('kind').notNull(),
    // Stable identifier for the "suggested default" this row was
    // instantiated from (e.g. 'daily-recap', 'dreaming-weekly'). Lets us
    // dedupe — user toggling the same suggestion on twice shouldn't
    // create two rows. NULL on future custom (NL-to-script) automations.
    suggestedId: text('suggested_id'),

    // ── Schedule ─────────────────────────────────────────────────────
    // Days of week as integers 0-6, postgres extract(dow) convention
    // (0=Sunday). Empty array = every day. Single-day-of-week schedules
    // (e.g. weekly recap on Mondays) use a one-element array.
    daysOfWeek: smallint('days_of_week')
      .array()
      .notNull()
      .default(sql`'{}'::smallint[]`),
    // Times of day to fire, in user-local time. Stored as "HH:MM"
    // strings for simplicity (avoids postgres time-zone semantics on
    // bare time columns). Multiple times supported — e.g. morning +
    // evening brief = ['07:00', '18:00'].
    times: text('times')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // IANA timezone for schedule interpretation (e.g. 'America/New_York').
    // Falls back to user_settings.timezone when row sets default 'UTC'.
    timezone: text('timezone').notNull().default('UTC'),
    // Jitter window in minutes. Actual fire time is the nominal time
    // PLUS a (user_id + automation_id)-stable hash offset within this
    // window. Default 30 min covers the common case where 100s of
    // users have the same nominal cadence. Set to 0 to disable
    // jitter (rare; would only be appropriate for single-user spec).
    jitterMinutes: integer('jitter_minutes').notNull().default(30),

    // Payload passed to the spawned agent_task when this automation
    // fires. Shape depends on kind. E.g. daily-recap may carry
    // { window_size_hours: 24 } or topic filters.
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),

    // Pause state. true → next_run_at = NULL → dispatcher skips.
    // Resume = paused=false + recompute next_run_at.
    paused: boolean('paused').notNull().default(false),

    // Next scheduled fire (UTC, jitter applied). Computed at insert,
    // update-of-schedule, and after each fire. NULL = paused or
    // not-yet-scheduled. Dispatcher sweep selects rows with
    // next_run_at <= now() and paused=false.
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),

    // Bookkeeping.
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    // Pointer to the most recently spawned agent_task for "View last run"
    // affordance in the Automations UI. ON DELETE SET NULL so the
    // recurring row survives if its last task is hard-deleted.
    lastAgentTaskId: uuid('last_agent_task_id').references(() => agentTasks.id, {
      onDelete: 'set null',
    }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Soft-delete. User toggle OFF sets this; rows are kept for
    // retention/analytics rather than hard-deleted.
    tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  },
  (t) => ({
    // For the Automations UI: list a user's active automations.
    userActiveIdx: index('recurring_agent_tasks_user_active_idx')
      .on(t.userId)
      .where(sql`tombstoned_at IS NULL`),
    // For the dispatcher sweep: find due-and-runnable rows fast.
    nextRunIdx: index('recurring_agent_tasks_next_run_idx')
      .on(t.nextRunAt)
      .where(sql`next_run_at IS NOT NULL AND paused = false AND tombstoned_at IS NULL`),
    // Dedup: a user can only have one row per (kind, suggested_id).
    // Future custom automations omit suggested_id → not constrained.
    userSuggestedUnique: uniqueIndex('recurring_agent_tasks_user_suggested_unique')
      .on(t.userId, t.kind, t.suggestedId)
      .where(sql`suggested_id IS NOT NULL AND tombstoned_at IS NULL`),
  }),
);
