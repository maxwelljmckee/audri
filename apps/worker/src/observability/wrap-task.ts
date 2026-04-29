// Sentry-aware wrapper around graphile-worker tasks. The handler still
// throws so graphile-worker handles retries/failures — we just intercept
// to capture the exception in Sentry first.

import * as Sentry from '@sentry/node';
import type { Task } from 'graphile-worker';

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
      throw err;
    }
  };
}
