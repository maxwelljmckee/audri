// SLA timeout sweep — flips any `call_transcripts` row whose
// `ingestion_status IN ('pending', 'running')` for longer than the
// ingestion SLA (15 min) to `failed`. Surfaces breaches via Sentry so we
// notice infra wedges; user-facing surface is the Notes pending banner
// which already renders failed state with retry CTA.
//
// Threshold: 15 min matches the undici headers-timeout ceiling configured
// in main.ts. Anything `pending`/`running` past that point is either
// (a) the worker process died mid-job (no recovery without this sweep),
// (b) /end POSTed but the ingestion enqueue silently failed, or
// (c) Gemini wedged + our retry logic burned through attempts without
// flipping to 'failed'. All three deserve a high-priority signal.
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
  const rows = await db.execute(sql.raw(`
    UPDATE call_transcripts
    SET ingestion_status = 'failed',
        ingestion_error = 'SLA timeout (>15min) — ingestion did not complete; worker may have died mid-job or downstream service wedged. Retry via the Notes pending banner.'
    WHERE ingestion_status IN ('pending', 'running')
      AND created_at < now() - ${SLA_THRESHOLD}
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
