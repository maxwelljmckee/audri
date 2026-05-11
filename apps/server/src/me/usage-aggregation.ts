// Monthly usage aggregation. Reads usage_events for the requested
// calendar month in the user's local timezone, buckets by user-facing
// category, and shapes the response for the mobile Usage screen.
//
// The "Live Agent" category silently absorbs all call-adjacent inference
// (the live session itself, post-call Flash retrieval + Pro fan-out +
// agent-scope Flash, plus the in-call wiki tools). From the user's POV
// the call is one experience; surfacing fan-out cost separately would
// confuse without informing. Web search and Research are billed as their
// own line items. Future plugin event_kinds fall into the `other` map.

import { db, sql, usageEvents } from '@audri/shared/db';

// Internal event_kind → user-facing category. Keep in sync with the
// `usage_event_kind` enum in packages/shared/src/db/schema/enums.ts.
const KINDS_BY_CATEGORY = {
  liveAgent: new Set<string>([
    'call_live',
    'ingestion_prefilter',
    'ingestion',
    'agent_scope_ingestion',
    'tool_search_wiki',
    'tool_fetch_page',
  ]),
  webSearch: new Set<string>(['web_search']),
  research: new Set<string>(['plugin_research']),
};

export interface UsageAggregationOpts {
  userId: string;
  // 'YYYY-MM' — assumed to be the user's local month. Required.
  month: string;
  // IANA timezone (e.g. 'America/Denver'). Falls back to UTC if missing.
  timezone: string | null;
  // From user_settings; pulled here for the limit/threshold computation.
  monthlySpendLimitCents: string | null; // NUMERIC arrives as string
  monthlySpendWarningThreshold: number;
}

export interface UsageAggregation {
  month: string;
  totalCents: number;
  daily: Array<{ day: string; cents: number }>;
  byCategory: {
    liveAgent: number;
    webSearch: number;
    research: number;
    // Unknown event_kinds (future plugins) fall here keyed by kind.
    other: Record<string, number>;
  };
  limit: {
    cents: number | null;
    thresholdReached: boolean;
    warningThreshold: number;
  };
}

interface RawRow {
  day: string;
  event_kind: string;
  cents: string; // NUMERIC sum arrives as string
}

export async function aggregateMonthlyUsage(opts: UsageAggregationOpts): Promise<UsageAggregation> {
  const tz = opts.timezone ?? 'UTC';

  // Validate `month` format defensively — a malformed value would land in
  // raw SQL via the date-cast. YYYY-MM, four-digit year, two-digit month.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) {
    throw new Error(`invalid month format: ${opts.month}; expected YYYY-MM`);
  }

  // Month bounds: take 'YYYY-MM-01' at the user's local midnight, convert
  // to UTC instants for the created_at filter. End bound is the first
  // instant of the NEXT month (exclusive) so DST edge days handle cleanly.
  const monthStartTs = sql`((${opts.month} || '-01')::timestamp AT TIME ZONE ${tz})`;
  const monthEndTs = sql`((${opts.month} || '-01')::timestamp AT TIME ZONE ${tz} + interval '1 month')`;
  const dayExpr = sql`to_char(${usageEvents.createdAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;

  const rows = (await db.execute(sql`
    SELECT
      ${dayExpr} AS day,
      ${usageEvents.eventKind} AS event_kind,
      SUM(${usageEvents.costCents})::text AS cents
    FROM ${usageEvents}
    WHERE ${usageEvents.userId} = ${opts.userId}
      AND ${usageEvents.createdAt} >= ${monthStartTs}
      AND ${usageEvents.createdAt} < ${monthEndTs}
    GROUP BY day, ${usageEvents.eventKind}
    ORDER BY day, event_kind
  `)) as unknown as RawRow[];

  // Walk rows once: compute total + per-day + per-category.
  let total = 0;
  const dailyMap = new Map<string, number>();
  const byCategory: UsageAggregation['byCategory'] = {
    liveAgent: 0,
    webSearch: 0,
    research: 0,
    other: {},
  };

  for (const row of rows) {
    const cents = Number.parseFloat(row.cents);
    if (!Number.isFinite(cents)) continue;
    total += cents;
    dailyMap.set(row.day, (dailyMap.get(row.day) ?? 0) + cents);
    if (KINDS_BY_CATEGORY.liveAgent.has(row.event_kind)) byCategory.liveAgent += cents;
    else if (KINDS_BY_CATEGORY.webSearch.has(row.event_kind)) byCategory.webSearch += cents;
    else if (KINDS_BY_CATEGORY.research.has(row.event_kind)) byCategory.research += cents;
    else byCategory.other[row.event_kind] = (byCategory.other[row.event_kind] ?? 0) + cents;
  }

  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, cents]) => ({ day, cents }));

  // Limit computation — soft only at v0.2.1.
  const limitCents = opts.monthlySpendLimitCents
    ? Number.parseFloat(opts.monthlySpendLimitCents)
    : null;
  const thresholdReached =
    limitCents !== null &&
    limitCents > 0 &&
    total >= limitCents * opts.monthlySpendWarningThreshold;

  return {
    month: opts.month,
    totalCents: total,
    daily,
    byCategory,
    limit: {
      cents: limitCents,
      thresholdReached,
      warningThreshold: opts.monthlySpendWarningThreshold,
    },
  };
}
