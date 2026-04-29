// @sentry/react-native init. DSN-gated: if EXPO_PUBLIC_SENTRY_DSN isn't set
// (e.g. local dev without telemetry), this is a no-op.
//
// Captures unhandled JS errors + native crashes via the Sentry plugin's
// auto-instrumentation. Manual Sentry.captureException() calls work too.

import * as Sentry from '@sentry/react-native';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  initialized = true;
  if (!DSN) {
    console.log('[sentry] no DSN set — skipping init');
    return;
  }
  Sentry.init({
    dsn: DSN,
    environment: __DEV__ ? 'development' : 'production',
    // Conservative tracing default — bump when you actually start using
    // performance traces.
    tracesSampleRate: 0.1,
    // Don't send PII by default.
    sendDefaultPii: false,
  });
  console.log('[sentry] initialized');
}

// Helper for caught errors that we don't want to crash on but DO want
// visible in Sentry. Always logs to console (preserves existing dev UX),
// additionally fires to Sentry with a tag identifying the call site.
export function captureClientError(
  area: string,
  err: unknown,
  extras?: Record<string, unknown>,
) {
  console.warn(`[${area}] error`, err, extras);
  Sentry.withScope((scope) => {
    scope.setTag('area', area);
    if (extras) {
      for (const [k, v] of Object.entries(extras)) {
        scope.setExtra(k, v as unknown);
      }
    }
    if (err instanceof Error) {
      Sentry.captureException(err);
    } else {
      Sentry.captureMessage(typeof err === 'string' ? err : JSON.stringify(err));
    }
  });
}

export { Sentry };
