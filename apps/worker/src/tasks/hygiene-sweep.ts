// Hygiene sweep — v0.2 item #9. Expires stale agent_open_items so the
// per-persona queue doesn't accumulate forever.
//
// Bypasses the agent_tasks dispatcher (which would require a `todo_page_id`
// the system has no good answer for) — system-driven scheduled jobs run as
// raw Graphile tasks, separate from user-visible work. See main.ts for the
// self-enqueue cadence.
//
// Lifecycle:
//   - Items with status='pending' older than MAX_AGE_DAYS get marked
//     'expired'. resolved_at + updated_at bumped so the lifecycle is
//     legible and the change replicates to mobile.
//   - Future: add call-count-based expiration (the v0.2 doc spec mentions
//     "8 calls max-stale") once we have a per-user call counter that's
//     cheap to query. Time-based is sufficient for v0.

import { db, sql } from '@audri/shared/db';
import type { Task } from 'graphile-worker';
import { logger } from '../logger.js';

// Configurable defaults. User-overridable cadence can land in V1+ once
// per-user persona-config UX exists.
const MAX_AGE_DAYS = 28;

export const hygieneSweep: Task = async (_payload, helpers) => {
  const start = Date.now();
  // One bulk UPDATE — cheap. Expires every pending item older than the
  // threshold across all users at once. Returns the number of rows updated
  // for observability.
  const result = await db.execute(sql`
    UPDATE agent_open_items
    SET status = 'expired',
        resolved_at = now(),
        updated_at = now()
    WHERE status = 'pending'
      AND created_at < now() - (${sql.raw(`${MAX_AGE_DAYS}`)} || ' days')::interval
  `);
  // postgres-js Result uses `.count` (not `.rowCount` — that's node-postgres).
  const expired = (result as unknown as { count?: number }).count ?? 0;
  const durationMs = Date.now() - start;
  helpers.logger.info(`hygiene_sweep expired=${expired} duration_ms=${durationMs}`);
  logger.info({ jobId: helpers.job.id, expired, durationMs }, 'hygiene_sweep complete');
};
