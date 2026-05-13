// Recurring automation dispatcher (v0.3.0 B1).
//
// Fires every minute from main.ts. Finds all recurring_agent_tasks rows
// whose next_run_at <= now() (with paused=false, not tombstoned), then
// for each:
//   1. Inserts an agent_tasks row with the same kind + payload (status
//      = 'pending'). This row goes through dispatch-agent-task.ts on the
//      next worker tick — inheriting the spend-cap gate, retry logic,
//      and handler lookup. Zero re-invention of task execution.
//   2. Records the spawn on the recurring row: last_run_at = now(),
//      last_agent_task_id = the new task id, next_run_at = recompute.
//   3. The dispatcher itself never *runs* the handler. It only emits
//      agent_tasks rows; the regular task pipeline picks them up.
//
// Idempotency: row's next_run_at is advanced before the new agent_task
// is committed, in the same transaction. So a worker crash mid-dispatch
// either fires nothing (rollback) or fires exactly once (commit). The
// recurring row will be picked up again on the next sweep with the
// already-advanced next_run_at.
//
// Spend-cap interaction: every recurring run produces an agent_task,
// which the standard dispatcher gates against the user's monthly cap.
// Over-cap → agent_task lands as 'blocked_over_cap' status; recurring
// row's next_run_at advances normally so the *next* period gets a
// fresh shot. (Locked design point per v0.3.0 #20.)

import { computeNextRunAt } from '@audri/shared/automations';
import { agentTasks, db, eq, sql } from '@audri/shared/db';
import { capture } from '@audri/shared/posthog';
import * as Sentry from '@sentry/node';
import type { Task } from 'graphile-worker';
import { logger } from '../logger.js';

interface DueRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  kind: string;
  suggested_id: string | null;
  days_of_week: number[];
  times: string[];
  timezone: string;
  jitter_minutes: number;
  payload: unknown;
  next_run_at: string;
}

export const dispatchRecurring: Task = async (_payload, helpers) => {
  const now = new Date();

  // Find due rows. Lean on the partial index on next_run_at — only
  // returns rows that are active, not paused, and overdue. Limit 100
  // per sweep to bound per-tick work even at much-higher scale; if
  // we're consistently hitting the limit we'd bump it (or shorten
  // the sweep interval).
  const result = await db.execute(sql`
    SELECT
      id,
      user_id,
      agent_id,
      kind::text,
      suggested_id,
      days_of_week,
      times,
      timezone,
      jitter_minutes,
      payload,
      next_run_at
    FROM recurring_agent_tasks
    WHERE next_run_at IS NOT NULL
      AND paused = false
      AND tombstoned_at IS NULL
      AND next_run_at <= ${now}
    ORDER BY next_run_at ASC
    LIMIT 100
  `);

  const dueRows = (result as unknown as { rows?: DueRow[] }).rows ?? [];

  if (dueRows.length === 0) {
    logger.debug({ jobId: helpers.job.id }, 'recurring dispatcher: no due rows');
    return;
  }

  logger.info(
    { jobId: helpers.job.id, count: dueRows.length },
    'recurring dispatcher: firing due automations',
  );

  for (const row of dueRows) {
    try {
      await fireOne(row, now);
    } catch (err) {
      // Per-row failure shouldn't stop the rest of the sweep. Log +
      // capture + advance to next. The row stays due (next_run_at
      // unchanged on rollback) so the NEXT sweep will retry the same
      // row — bounded by graphile_worker task retries on this
      // dispatcher task.
      logger.error(
        { err, recurringId: row.id, kind: row.kind, userId: row.user_id },
        'recurring dispatcher: per-row fire failed',
      );
      Sentry.captureException(err, {
        tags: { event: 'recurring-dispatch-fire-failed' },
        extra: { recurringId: row.id, kind: row.kind, userId: row.user_id },
      });
    }
  }
};

async function fireOne(row: DueRow, now: Date): Promise<void> {
  // Recompute next_run_at BEFORE firing so an inflight crash doesn't
  // re-fire the same automation. Pass `now` as the from-time so we
  // advance past the current fire.
  const nextRunAt = computeNextRunAt(
    {
      daysOfWeek: row.days_of_week,
      times: row.times,
      timezone: row.timezone,
      jitterMinutes: row.jitter_minutes,
    },
    { userId: row.user_id, recurringTaskId: row.id },
    now,
  );

  await db.transaction(async (tx) => {
    // 1. Spawn the agent_task. todoPageId is null for automation-driven
    //    runs (research is the only kind that requires a tracking todo,
    //    and research isn't scheduled-recurring today).
    const inserted = await tx
      .insert(agentTasks)
      .values({
        userId: row.user_id,
        agentId: row.agent_id,
        // biome-ignore lint/suspicious/noExplicitAny: kind is the agent_task_kind pgEnum, narrowed at row-read time
        kind: row.kind as any,
        payload: (row.payload as object) ?? {},
        status: 'pending',
      })
      .returning({ id: agentTasks.id });

    const newTaskId = inserted[0]?.id;
    if (!newTaskId) {
      throw new Error('recurring dispatcher: agent_tasks insert returned no id');
    }

    // 2. Advance the recurring row.
    await tx.execute(sql`
      UPDATE recurring_agent_tasks
      SET
        last_run_at = ${now},
        last_agent_task_id = ${newTaskId},
        next_run_at = ${nextRunAt},
        updated_at = ${now}
      WHERE id = ${row.id}
    `);

    // 3. Enqueue the graphile job that'll actually run the handler.
    //    Same path as ingestion + research enqueue: dispatch-agent-task
    //    looks up the kind in the plugin registry and runs the matching
    //    handler.
    const dispatchPayload = JSON.stringify({ agentTaskId: newTaskId });
    await tx.execute(sql`
      SELECT graphile_worker.add_job(
        'agent_task_dispatch',
        ${dispatchPayload}::json,
        max_attempts => 2
      )
    `);
  });

  capture(row.user_id, 'automation.fired', {
    recurringId: row.id,
    kind: row.kind,
    suggestedId: row.suggested_id ?? undefined,
  });
}
