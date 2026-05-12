// Sentry-aware wrapper around graphile-worker tasks. The handler still
// throws so graphile-worker handles retries/failures — we just intercept
// to capture the exception in Sentry first.

import * as Sentry from '@sentry/node';
import type { Task } from 'graphile-worker';
import { logger } from '../logger.js';

export function withSentry(name: string, task: Task): Task {
  return async (payload, helpers) => {
    try {
      await task(payload, helpers);
    } catch (err) {
      Sentry.withScope((scope) => {
        scope.setTag('graphile_task', name);
        scope.setExtra('jobId', helpers.job.id);
        scope.setExtra('attempt', helpers.job.attempts);
        scope.setExtra('max_attempts', helpers.job.max_attempts);
        Sentry.captureException(err);
      });
      // Force the event out before the throw cascades. Graphile retries
      // can produce bursts where a transient flush gets missed otherwise.
      // 2s budget — generous; flush returns whether the queue drained.
      try {
        const flushed = await Sentry.flush(2000);
        if (!flushed) {
          logger.warn(
            { graphile_task: name, jobId: helpers.job.id },
            '[sentry] flush timed out — event may not have been transmitted',
          );
        }
      } catch (flushErr) {
        logger.warn({ err: flushErr }, '[sentry] flush threw');
      }
      throw err;
    }
  };
}
