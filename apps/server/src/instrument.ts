// Sentry SDK v8 init MUST happen before any other instrumented modules
// (Express, http, undici, etc.) are imported. This file is the very first
// thing main.ts imports so the auto-instrumentation hooks land before the
// modules they wrap. Per https://docs.sentry.io/platforms/javascript/guides/nestjs/

import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN_SERVER;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0.1,
  });
  // eslint-disable-next-line no-console -- pre-Nest, no logger available
  console.log('[sentry] initialized (instrument.ts, pre-import)');
} else {
  // eslint-disable-next-line no-console
  console.log('[sentry] no DSN set — skipping init');
}
