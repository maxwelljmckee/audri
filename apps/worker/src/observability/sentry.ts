import * as Sentry from '@sentry/node';
import { logger } from '../logger.js';

// Reads either SENTRY_DSN_WORKER (preferred — names the service) or
// SENTRY_DSN_SERVER (back-compat — historically the worker shared the
// server's var name, which made per-service Render config error-prone).
// Either one works; if both are set, the WORKER-specific one wins.
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN_WORKER ?? process.env.SENTRY_DSN_SERVER;
  if (!dsn) {
    // WARN-level so this can't be missed in Render logs — Sentry being
    // off in production silently is exactly the failure mode we hit
    // 2026-05-12 when worker errors weren't surfacing.
    logger.warn(
      '[sentry] NO DSN SET — worker exceptions WILL NOT reach Sentry. Set SENTRY_DSN_WORKER on the Render worker service.',
    );
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
  });
  logger.info(
    { source: process.env.SENTRY_DSN_WORKER ? 'SENTRY_DSN_WORKER' : 'SENTRY_DSN_SERVER' },
    '[sentry] initialized',
  );
}
