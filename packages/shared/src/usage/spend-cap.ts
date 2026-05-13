// Hard spending-cap check — returns whether a user is over their
// configured monthly spend limit. Called pre-inference at every entry
// point that costs money (call start, ingestion enqueue, research
// handler, agent_task dispatch).
//
// Cached per-userId for SPEND_CAP_TTL_MS so repeated checks within a
// short window don't each query usage_events. TTL is short enough that
// stale-cache windows don't allow meaningful overage (spend accrues at
// ~cents/call; a 60s stale window is at most ~10c slop on a heavy user).
//
// Returns `null` (allow) when the user has no limit configured.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userSettings } from '../db/schema/identity.js';
import { usageEvents } from '../db/schema/usage.js';
import { eq } from 'drizzle-orm';

export interface SpendCapStatus {
  // True when current_month_spend >= monthly_spend_limit_cents.
  // False when under-cap (or no limit configured).
  overCap: boolean;
  // Current month-to-date spend in cents (string per NUMERIC(12,4)
  // semantics; parse with Number() when comparing).
  currentSpendCents: string;
  // User's configured limit, or null if none set (overCap will be false).
  limitCents: string | null;
  // ISO timestamp of the user-local month boundary used for the spend
  // aggregation. Useful for diagnostic / error response bodies.
  monthStart: string;
}

const SPEND_CAP_TTL_MS = 60_000;

interface CacheEntry {
  status: SpendCapStatus;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// Invalidate a user's cached cap status. Call after `PUT /me/spending-limit`
// so the next inference picks up the new limit immediately rather than
// waiting for TTL.
export function invalidateSpendCap(userId: string): void {
  cache.delete(userId);
}

export async function checkSpendCap(userId: string): Promise<SpendCapStatus> {
  const cached = cache.get(userId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.status;

  const [settings] = await db
    .select({
      limitCents: userSettings.monthlySpendLimitCents,
      timezone: userSettings.timezone,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  // No row OR no limit configured → never over cap. Don't cache the
  // user-row-missing branch (could be a setup race); cache the
  // no-limit branch since that's a legitimate steady state.
  if (!settings) {
    return {
      overCap: false,
      currentSpendCents: '0',
      limitCents: null,
      monthStart: new Date().toISOString(),
    };
  }
  if (!settings.limitCents) {
    const status: SpendCapStatus = {
      overCap: false,
      currentSpendCents: '0',
      limitCents: null,
      monthStart: new Date().toISOString(),
    };
    cache.set(userId, { status, expiresAt: now + SPEND_CAP_TTL_MS });
    return status;
  }

  // User-local month boundary. `AT TIME ZONE` does timezone-aware
  // truncation in postgres. Fall back to UTC when timezone is unset.
  const tz = settings.timezone || 'UTC';
  const aggregate = await db.execute(sql`
    SELECT
      COALESCE(SUM(cost_cents), 0) AS spend_cents,
      date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz} AS month_start
    FROM ${usageEvents}
    WHERE user_id = ${userId}
      AND created_at >= date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}
  `);
  const row = (aggregate as unknown as { rows: Array<{ spend_cents: string; month_start: Date }> })
    .rows[0];
  const currentSpendCents = row?.spend_cents ?? '0';
  const monthStart = row?.month_start
    ? new Date(row.month_start).toISOString()
    : new Date().toISOString();

  const overCap = Number(currentSpendCents) >= Number(settings.limitCents);
  const status: SpendCapStatus = {
    overCap,
    currentSpendCents,
    limitCents: settings.limitCents,
    monthStart,
  };
  cache.set(userId, { status, expiresAt: now + SPEND_CAP_TTL_MS });
  return status;
}

// Convenience boolean wrapper for the common case where only the
// gate decision matters.
export async function isOverSpendCap(userId: string): Promise<boolean> {
  const status = await checkSpendCap(userId);
  return status.overCap;
}
