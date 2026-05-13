// SLA timeout sweep — flips a `call_transcripts` row to `failed` when its
// `ingestion_status IN ('pending', 'running')` AND no Graphile job is
// still actively working on it. Surfaces breaches via Sentry so we
// notice infra wedges; user-facing surface is the Notes pending banner
// which already renders failed state with retry CTA.
//
// Why both conditions:
//   - Time-staleness alone (created_at > 15 min) races in-flight retries.
//     A row whose call started this morning can be retried this afternoon;
//     between the moment the worker flips status to 'running' and the
//     moment it succeeds, the sweep would otherwise falsely flag the row
//     as failed. Caught this on 2026-05-13 in field test — banner
//     flickered failed→succeeded during a successful retry.
//   - Job-presence alone would miss the case where /end POSTed but the
//     ingestion-job enqueue silently failed: status=pending, no job, no
//     time bound. The age guard rules out brand-new pending rows that
//     just haven't been picked up yet.
//   - Together: row is genuinely stuck — no work in progress AND old
//     enough that we'd expect progress by now.
//
// Threshold: 15 min matches the undici headers-timeout ceiling configured
// in main.ts. Anything `pending`/`running` past that point with no active
// job is either (a) the worker process died mid-job, (b) /end POSTed but
// the ingestion enqueue silently failed, or (c) Gemini wedged + retry
// logic exhausted without flipping to 'failed'. All three deserve a
// high-priority signal.
//
// Idempotent — re-running over a row already flipped to 'failed' is a
// no-op (the WHERE clause filters those out).

import { callTranscripts, db, eq, sql } from '@audri/shared/db';
import { capture } from '@audri/shared/posthog';
import * as Sentry from '@sentry/node';
import type { Task } from 'graphile-worker';
import { logger } from '../logger.js';

// 15 min — matches main.ts FETCH_TIMEOUT_MS. If you bump that, bump this.
const SLA_THRESHOLD = "interval '15 minutes'";

export const expireStaleIngestion: Task = async (_payload, helpers) => {
  // Two-part WHERE: (a) row has been pending/running for >SLA, AND
  // (b) no active Graphile job exists for it. The NOT EXISTS subquery
  // matches by task_identifier + payload's transcriptId; if any job
  // (running, queued, retry-pending) is still associated with this
  // transcript, we leave it alone.
  //
  // **Schema note (2026-05-13 incident):** The public view
  // `graphile_worker.jobs` does NOT expose `payload` — it's a join view
  // over `_private_jobs` + `_private_tasks` + `_private_job_queues`
  // that strips the payload column for surface ergonomics. The actual
  // payload lives on `_private_jobs`. We query that internal table
  // directly + join `_private_tasks` for the task_identifier filter.
  // Stable across recent graphile-worker versions but technically
  // implementation-detail; if graphile bumps the schema again we'll
  // need to update this query. Earlier version of this sweep referenced
  // `j.payload` on the view and silently failed every sweep run for
  // hours before we caught it in Render logs.
  const rows = await db.execute(sql.raw(`
    UPDATE call_transcripts ct
    SET ingestion_status = 'failed',
        ingestion_error = 'SLA timeout (>15min) — ingestion did not complete and no active worker job exists. Worker may have died mid-job or the enqueue silently failed. Retry via the Notes pending banner.'
    WHERE ct.ingestion_status IN ('pending', 'running')
      AND ct.created_at < now() - ${SLA_THRESHOLD}
      AND NOT EXISTS (
        SELECT 1
        FROM graphile_worker._private_jobs j
        INNER JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = 'ingestion'
          AND (j.payload::jsonb ->> 'transcriptId') = ct.id::text
      )
    RETURNING id, user_id, session_id, ingestion_status, created_at
  `));

  // Drizzle returns the postgres driver's QueryResult shape; the rows
  // sit on .rows. Cast to a row type for the per-row work below.
  const breached = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];

  if (breached.length === 0) {
    logger.debug({ jobId: helpers.job.id }, 'sla sweep: no breached rows');
    return;
  }

  logger.warn(
    { jobId: helpers.job.id, count: breached.length },
    'sla sweep: flipped stale ingestion rows to failed',
  );

  for (const row of breached) {
    const transcriptId = String(row.id);
    const userId = String(row.user_id);
    const sessionId = String(row.session_id ?? '');
    const previousStatus = String(row.ingestion_status ?? 'unknown');
    const createdAt = row.created_at;

    Sentry.captureMessage('[ingestion] SLA breach — stale row flipped to failed', {
      level: 'warning',
      tags: {
        event: 'ingestion-sla-breach',
        previous_status: previousStatus,
      },
      extra: {
        transcriptId,
        userId,
        sessionId,
        previousStatus,
        createdAt,
      },
    });

    capture(userId, 'ingestion.sla_breach', {
      transcriptId,
      sessionId,
      previousStatus,
    });
  }
};

// Ensure callTranscripts + eq are considered used (drizzle imports for
// typing parity with sibling files; the actual SQL uses raw template
// strings for the bulk UPDATE).
void callTranscripts;
void eq;
