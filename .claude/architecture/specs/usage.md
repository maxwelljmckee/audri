# SPEC — Usage / cost-tracking dashboard

Status: **draft** — v0.2.1 shipped (2026-05-11). Reflects landed behavior; values that need future iteration are flagged inline.

The Usage screen surfaces a user's per-calendar-month inference spend on Audri. Reads `usage_events`, buckets by user-local day + by user-facing category, exposes a soft monthly spending limit, and primes the substrate for hard enforcement in v0.4.0+.

---

## User-facing surface

`Account → Usage`. Single screen, top-to-bottom:

1. **Month label + total spend** — large dollar figure for the current calendar month in the user's local timezone.
2. **Spend-limit progress bar** — only when the user has set a monthly limit. Bar fills proportionally; tints red when current spend ≥ `warningThreshold × limit`.
3. **Soft-warning banner** — fires when the threshold is reached. Informational only; no inference gating in v0.2.1.
4. **Daily bar chart** — one bar per day of the current month. Bar height = spend that day. Empty days render as muted stubs so the bar chart reads as a calendar timeline.
5. **Category pie chart** — Live Agent / Research / Web Search slices plus a generic "other" bucket for plugin kinds we add later.
6. **Small print** — explains how categories map to inference paths (so the user can answer "why is Live Agent expensive" by understanding that ingestion + tool calls roll up into it).

The whole top card (total + limit progress + warning) is tappable → opens the limit-management modal.

---

## Categories — user-facing vs. internal

Internal `usage_event_kind` enum is finer-grained than the user-facing breakdown. The collapse:

| User-facing category | `usage_event_kind` values |
|---|---|
| **Live Agent** | `call_live` + `ingestion_prefilter` + `ingestion` + `agent_scope_ingestion` + `tool_search_wiki` + `tool_fetch_page` |
| **Web Search** | `web_search` |
| **Research** | `plugin_research` |
| **Other** (future plugins) | any new `event_kind` not in the above three sets |

**Why "Live Agent" absorbs ingestion + tool calls:** from the user's POV the call is one experience. The post-call ingestion fan-out runs because the user had a call; the in-call wiki tools were used during that call. Surfacing those as separate line items would confuse without informing. The single "Live Agent" line answers "what did my conversations cost this month."

The grouping rule lives in `apps/server/src/me/usage-aggregation.ts:KINDS_BY_CATEGORY`. When a new plugin lands with its own `event_kind`, decide at that time whether it rolls up into an existing category or gets its own line — usually its own line.

---

## Aggregation contract — `GET /me/usage`

```ts
GET /me/usage?month=YYYY-MM     // month defaults to current in user's tz

→ {
  month: string,                          // 'YYYY-MM'
  totalCents: number,                     // sum across all event_kinds
  daily: Array<{ day: string, cents: number }>,   // 'YYYY-MM-DD' user-local
  byCategory: {
    liveAgent: number,
    webSearch: number,
    research: number,
    other: Record<string, number>,
  },
  limit: {
    cents: number | null,                 // null = no limit set
    thresholdReached: boolean,            // current >= limit * threshold
    warningThreshold: number,             // (0, 1], default 0.8
  },
}
```

Costs are returned as JavaScript `number` (cents at NUMERIC(12,4) precision — JS Number is safe up to ~9 quadrillion, so cents stay precise). Total = sum of byCategory + sum of byCategory.other.

The mobile renderer pads `daily` to include every day of the month with 0 cents — gives the bar chart a calendar-shaped timeline rather than a gappy histogram.

---

## Timezone handling

All "month" boundaries (current month start, daily buckets) use the user's IANA timezone from `user_settings.timezone`. NULL falls back to UTC.

Mobile client populates the field on first launch by POSTing `{ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }` to `PUT /me/timezone`. The post fires only when device-detected tz differs from the server's stored value (cheap on subsequent launches). If the post fails, the aggregation falls back to UTC — re-posted next launch.

The aggregation query computes month bounds via Postgres `AT TIME ZONE`: `('YYYY-MM-01'::timestamp AT TIME ZONE tz)` for the start instant, `+ interval '1 month'` for the exclusive end. Daily bucketing uses `to_char(created_at AT TIME ZONE tz, 'YYYY-MM-DD')`. DST edge days handle cleanly via the exclusive-end-bound pattern.

---

## Spending limits — soft only at v0.2.1

| Field on `user_settings` | Type | Default | Meaning |
|---|---|---|---|
| `monthly_spend_limit_cents` | NUMERIC(12, 2), NULL | NULL | Monthly cap in cents. NULL = no cap. |
| `monthly_spend_warning_threshold` | REAL, NOT NULL | 0.8 | Fraction of limit at which the banner fires. (0, 1]. |

**v0.2.1 ships read + soft-warning only.** No inference gating. Hard enforcement (server blocks inference when current spend ≥ limit) is deferred to v0.4.0 or its own slice because:
- The failure modes are user-visible (blocked mid-session, paused calls) and need field-tested usage data to tune correctly.
- Per-category caps (e.g. "$5/mo on web search specifically") might be the better shape for hard enforcement — undecided.
- The substrate (limit columns + read path) lands at v0.2.1, so gate-at-inference-start is a future code change against existing data.

`PUT /me/spending-limit` body: `{ limit_cents: number | null, threshold?: number }`. Validates: `limit_cents ≥ 0 || null`, `threshold ∈ (0, 1]`. Returns 200 on success.

---

## Pricing module

Static per-model table at `packages/shared/src/usage/pricing.ts`. Per-model entries carry `inputUsdPerMillion`, `outputUsdPerMillion`, optional `cachedInputUsdPerMillion`, optional per-modality audio rates for Live, and an `asOf` annotation that must be updated when the entry is re-verified.

**Pricing is best-effort and needs periodic verification.** Gemini publishes per-model pricing on the AI Studio pricing page; the table needs a refresh roughly every 6 months or whenever a new model is wired in. The `asOf` field flags how stale each entry is.

**Special-case grounding pricing:**
- `WEB_SEARCH_USD_PER_REQUEST = 0.014` ($14 / 1k for Gemini 3.x). Gemini 2.5 grounding is $35/1k — but our only grounded paths are 3.1-pro-preview (research) and 3.1-flash-live-preview (Live calls), so the 3.x rate applies universally to us.
- `MAPS_SEARCH_USD_PER_REQUEST = 0` placeholder until the maps-grounding tool lands (see `backlog.md`).

**Tier-2 detection (NOT tier-aware pricing):** `gemini-2.5-pro` and `gemini-3.1-pro-preview` charge a higher rate above 200k prompt tokens. The pricing module currently uses a single rate per model. When a prompt crosses the threshold, `isTier2Crossover` returns true; the worker wrapper of `recordInferenceUsage` fires a Sentry `captureMessage` (level `warning`, tags include `event_kind` + `model`) so we know to land tier-aware math. Cost is *under-counted* until then. v0.2.1: caught + logged, not fixed.

**Modality-aware Live pricing:** Gemini Live's `UsageMetadata` splits token counts by modality (AUDIO/TEXT/IMAGE/VIDEO/DOCUMENT). Audio is priced ~6× text. `computeCostCents` walks `promptTokensDetails` + `responseTokensDetails` for per-modality rates when both the model entry and the usage data support it.

---

## Writers — where `usage_events` rows come from

| `event_kind` | Where written | Notes |
|---|---|---|
| `call_live` | `apps/server/src/calls/calls.controller.ts` `/end` handler | Reads `LiveServerMessage.usageMetadata` accumulated by mobile (last-wins) and passed through in `body.tool_calls.sessionUsage`. |
| `ingestion_prefilter` | `apps/worker/src/tasks/ingestion.ts` after `retrieveCandidates` | Fires regardless of noteworthiness gate (Flash already ran). |
| `ingestion` | Same task, after `runFanOut` | Largest single cost per call typically. |
| `agent_scope_ingestion` | `apps/worker/src/ingestion/agent-scope.ts:runAgentScopeIngestion` | Inline write (function has all the context). |
| `plugin_research` | `apps/worker/src/research/commit.ts` | In the same transaction as the artifact write. |
| `tool_search_wiki` | `apps/server/src/calls/calls.controller.ts` tool endpoint | $0 cost (Postgres only); event recorded for tool-frequency analytics. |
| `tool_fetch_page` | Same | $0 cost; same rationale. |
| `web_search` | `apps/worker/src/tasks/ingestion.ts` | Reads `tool_calls.groundingHits[].webSearchQueries[].length`, sums to credits, writes one row per call with `cost = credits × WEB_SEARCH_USD_PER_REQUEST`. |

All writers are best-effort: failures log + swallow, never break the surrounding work. Helper: `@audri/shared/usage::recordInferenceUsage` (and `recordWebSearchUsage`).

---

## Out of scope / V1+

- **Hard server-side enforcement** of spend caps (v0.4.0 or own slice)
- **Per-category limits** (just monthly total today)
- **Push notifications** when approaching/exceeding limit
- **Per-agent breakdown UI** (substrate ships — `agentId` populated on all writers — UI lands when multi-agent specialists exist)
- **Tier-aware pricing math** for >200k prompts (Sentry-logged + flagged in code)
- **Backfill** of historical events (locked: skip)
- **LiteLLM / provider abstraction** (deferred; v0.2.1's pricing module is provider-agnostic by `model` string so future swaps don't paint into a corner)
- **OpenAI Realtime swap** (separate phase if pursued; v0.2.1 forward-compat)
- **Cost-per-call detail view on Chat History** (natural follow-up)
- **CSV export / invoice-style report** (V1+)
- **Plugin marketplace tying to usage limits** (V1+)

---

## Related decisions

- `build-phases/v0.2.1.md` — full DP list + sequencing for this cycle
- `build-phases/v0.2.0.md` — `tool_calls` capture that the Live + web-search writers rely on
- `packages/shared/src/db/schema/usage.ts` — `usage_events` table definition (mostly pre-existing; only the writers caught up at v0.2.1)
- `packages/shared/src/usage/pricing.ts` — pricing table source-of-truth + cost-compute helpers
- `apps/server/src/me/usage-aggregation.ts` — the GROUP BY user-local-day + category builder
- `backlog.md` — `maps-grounding` tool entry that this spec's substrate will absorb cleanly
