// PostHog server-side client. Singleton across the process so SDK-internal
// batching + flag caching are shared.
//
// Usage from server / worker:
//   import { isFeatureEnabled, capture, shutdownPosthog } from '@audri/shared/posthog';
//   if ((await isFeatureEnabled('ingestion_enabled', userId)) === false) return;
//   capture(userId, 'ingestion.started', { transcriptId });
//
// Both helpers are no-ops when POSTHOG_API_KEY isn't set (local dev w/o
// telemetry, or any environment that hasn't been wired). That keeps the
// integration zero-config-failure: missing keys mean disabled telemetry,
// not crashes.

import { PostHog } from 'posthog-node';

let _client: PostHog | null = null;
let _attemptedInit = false;

function getClient(): PostHog | null {
  if (_attemptedInit) return _client;
  _attemptedInit = true;
  const key = process.env.POSTHOG_API_KEY;
  if (!key) return null;
  _client = new PostHog(key, {
    host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
    // Flush every 30s OR when we hit ~20 buffered events. Worker processes
    // can produce events in bursts (per-job lifecycle), so the queue keeps
    // the network chatter sane.
    flushAt: 20,
    flushInterval: 30_000,
  });
  return _client;
}

// Returns true / false from PostHog, OR undefined when the SDK couldn't
// resolve the flag (network failure, key missing, flag not defined yet).
// **Fail-open semantics**: callers should treat undefined as "enabled" —
// kill switches are for explicit disable, not for bricking the pipeline
// when PostHog is unreachable.
export async function isFeatureEnabled(
  flagKey: string,
  distinctId: string,
): Promise<boolean | undefined> {
  const client = getClient();
  if (!client) return undefined;
  try {
    return await client.isFeatureEnabled(flagKey, distinctId);
  } catch {
    return undefined;
  }
}

export function capture(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  const client = getClient();
  if (!client) return;
  client.capture({ distinctId, event, properties });
}

// Flush + close the client. Call from shutdown handlers (SIGTERM, SIGINT)
// so buffered events don't get dropped on graceful restarts.
export async function shutdownPosthog(): Promise<void> {
  if (!_client) return;
  await _client.shutdown();
}
