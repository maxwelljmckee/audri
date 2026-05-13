# Audri — System bottlenecks

Living document for system-level performance + scale concerns we know about but aren't urgently blocking. Goal: trip-mine the architecture so we spot pressure before it bites in production. Entries land here when we identify a future bottleneck while doing feature work; they're not commitments to fix today, just structured awareness so we can act when telemetry tells us to.

Each entry follows the shape:

- **What:** the bottleneck or concern in one sentence.
- **Why it matters:** when it becomes load-bearing.
- **Current state:** what's in place today, including any mitigations already shipped.
- **Trigger conditions:** the signals that say "act now" — usage thresholds, telemetry alerts, user-visible symptoms.
- **Remediation plan:** the concrete first move when the trigger fires. May reference backlog entries.

Entries are loosely ordered by urgency / proximity to triggering.

---

## ⚠️ Supabase egress at private-release scale (TOP PRIORITY)

**What:** We're burning roughly 5 GB / real-user / month of Supabase egress, sustained at ~211 MB/day across the project. Pro tier's 250 GB included budget covers **~50 real users** before overages kick in at $0.09/GB. **Private-release target (10-50 trusted testers) lands within striking distance of overages on day one if per-user behavior matches Max's current usage.**

**Note on MAU counting:** Supabase's MAU metric is event-based (counts auth events, not unique users — each dev rebuild / session refresh / new JWT counts). The 9 MAU figure with 1 row in `auth.users` confirms this. MAU billing is generous (100k included on Pro, $0 at our scale forever); the real bottleneck is the egress GB number, which tracks actual data flow per real user.

**Why it matters:** This is the only bottleneck on the list that *already* has a hard near-term ceiling — we'll hit it during private release, not at hypothetical scale. Overage costs are real money even at moderate breach (100 real users at 5 GB each = 500 GB → 250 GB overage = ~$22/month). At 500 real users it's ~$200/month. Compounding indefinitely until tightened.

**Current state:**
- Free tier (5 GB/month), 3.45 GB consumed at day 13 of cycle, projecting to ~7-8 GB/month from one heavy user (Max). Already at risk of free-tier cutoff this billing period.
- Daily egress is consistent (~211 MB/day) — not a one-off spike; this is steady-state per-user cost.
- Dominant source is almost certainly **RxDB realtime sync** — the mobile client maintains long-lived subscriptions to wiki_pages, wiki_sections, todos, agent_tasks, research_outputs, call_transcripts and pulls full row payloads on every write. Plus initial-hydration full-table dumps on every app cold-start.
- Cached egress = 0 GB — we're not benefiting from any caching layer.
- No payload-size audit has been done on what RxDB ships to mobile vs. what it actually needs.

**Trigger conditions:**
- Already triggered. Plan upgrade to Pro tier before next billing cycle to avoid free-tier cutoff.
- Post-upgrade, monitor: egress trending toward 250 GB / month inflection point as MAU grows.
- Per-MAU egress ratio creeping above 7 GB → indicates a feature regression (something newly ships large payloads to mobile).

**Remediation plan:**

1. **Immediate (this week):** Upgrade to Pro tier. $25/mo + 250 GB included buys breathing room. Not a fix — just buys time.

2. **Audit what RxDB actually replicates to mobile (highest-impact win).** Open `apps/mobile/lib/rxdb/replication.ts` and the collection schemas; for each push/pull-enabled table, ask: *does mobile genuinely need this data, or just a metadata subset?* Likely culprits to investigate:
   - **`call_transcripts.content`** — full transcripts in JSONB, possibly 10-50 KB each. Chat History list only needs `{ id, title, started_at, ended_at, ingestion_status }`; full content is only needed when user opens a specific chat detail. **Strong candidate to demote to server-fetch-on-tap.** This alone could halve egress per active user.
   - **`call_transcripts.tool_calls`** — large JSONB with sessionUsage + grounding hits. Debug data; mobile doesn't render it.
   - **`call_transcripts.pro_fan_out_response`** — server-only debug column. If this is replicated, MUST be removed; Pro fan-out payloads are large.
   - **`wiki_section_history`** — versioned-history table; mobile doesn't show edit history. Don't replicate.
   - **`extracted_claims`** — debug data on what Pro extracted; mobile doesn't surface.
   - **`agent_tasks.payload`** — full task payload (research query, context); mobile only needs status + title for surfacing on the todo row.

3. **Reduce realtime push frequency / coalesce updates.** RxDB's default sync is aggressive — every row write produces a push event. For high-write tables (wiki_log, wiki_section_history), throttle to a server-side coalescer (every N seconds emit accumulated changes). Reduces WS message count + cumulative payload size.

4. **Compress WS messages.** Check Supabase realtime config — `permessage-deflate` may not be enabled by default. Tests at 10:1 compression on JSON. Compounds with #2 since smaller-payload baseline gets compressed too.

5. **CDN-front cacheable read endpoints.** `/me/usage`, `/me/profile`, agent metadata — all cacheable for 60s. Adds Cloudflare or Render CDN in front. Cached egress is billed cheaper ($0.03/GB vs $0.09/GB on Pro).

6. **Long-horizon: pull-on-demand for cold data.** Today RxDB hydrates the user's entire history on every app start. Refactor to: most-recent-N rows on cold start + scroll-back triggers paginated pulls. Bigger refactor but flatlines per-user egress regardless of how much history accrues.

**Backlog entry exists:** see `backlog.md` → "Revisit Graphile concurrency + multitenant scaling bottlenecks" — extend to reference this entry. Also probably worth a dedicated backlog entry for the RxDB-replication audit since it's actionable now.

---

## Graphile worker concurrency + Node event-loop semantics

**What:** The worker (`apps/worker`) runs at `concurrency: 4` in a single Render service instance. Each long-running Gemini call (Pro fan-out, research handler, agent-scope ingestion) occupies one of those four slots for the duration of its await.

**Why it matters:** At >4 simultaneous in-flight jobs, the 5th user waits. Today (1-10 users) this is unobservable; at private-release scale (10-50 users) it may start surfacing as pending-banner latency; at public release it's a hard ceiling.

**Current state:**
- `concurrency: 4` set in `apps/worker/src/main.ts`. One worker process, one Render instance.
- Per-user FIFO via `queue_name = 'ingestion-${user_id}'` — Graphile's named queues serialize jobs within a queue but parallelize across users. So users don't race each other; a single user's bursts also can't pile-drive Gemini.
- Node event loop is **never** locked by an awaited HTTP call — multiple slots in the same process await Gemini in parallel just fine. The single-threaded process serves dozens of concurrent network awaits with no contention.
- Streaming swap (v0.3.0 #67) means each Pro call holds a slot for streaming duration but the headers-timeout cliff is gone.

**Trigger conditions:**
- PostHog dashboard shows ingestion enqueue → start latency creeping above ~10s during active periods.
- Notes pending banner staying lit for minutes on jobs where Flash + Pro themselves are fast.
- Manual `SELECT count(*) FROM graphile_worker.jobs WHERE task_identifier = 'ingestion' AND locked_at IS NULL` consistently > 4.

**Remediation plan:**
1. First-order — bump `concurrency` in `main.ts` to 16 (one-line change; redeploy worker). Validate via the latency telemetry above. Node can comfortably handle 50+ concurrent HTTP awaits per process.
2. Second-order — horizontal scaling. Spin up a second `audri-worker` Render instance; they both poll the same `graphile_worker.jobs` table and split work automatically. Graphile Worker is designed for this; no code changes required, just service-config.
3. Third-order — split worker pools by job kind (a "fast" worker for hygiene + heartbeat + SLA sweep; a "slow" worker for ingestion + research). Avoids long jobs starving short ones. Requires either separate Render services with `--task-list` filtering OR Graphile's pool-affinity feature. Backlog: "Per-kind concurrency caps."

---

## Postgres connection pool exhaustion

**What:** Drizzle's pg pool has a default size of 10-20 connections per process. Some of our handlers hold a connection across an await (most notably: the section-merge GenAI calls inside the ingestion commit transaction, added during the slug-collision work).

**Why it matters:** A commit with N section-merges holds the connection for N × 1-2s. With 4 concurrent ingestion slots each doing 3 merges, that's potentially 12 long-held connections — already inside the default pool range. At higher concurrency or higher merge counts, pool exhaustion deadlocks the worker.

**Current state:**
- Default pg pool size (whatever Drizzle's default is in `packages/shared/src/db/client.ts`; haven't audited).
- Section-merge call lives **inside** the open transaction in `apps/worker/src/ingestion/commit.ts`.
- Comment in commit.ts already flags this: *"tx-hold time grows with the number of merges in a commit; at our scale (rare, small N) this is acceptable. Revisit if it becomes a connection-pool problem."*

**Trigger conditions:**
- Connection-pool timeout errors in worker logs ("timeout exceeded when trying to connect").
- Render service exhibiting periodic stalls correlated with peak ingestion activity.
- Pool-usage telemetry (if PostHog or Sentry breadcrumb instrumented) showing sustained > 80% utilization.

**Remediation plan:**
1. First-order — confirm + bump pool size in `client.ts` to e.g. 50 connections per worker process. Cheap; Postgres can handle thousands of connections (subject to `max_connections` on the DB).
2. Second-order — refactor section-merge to run OUTSIDE the transaction. Compute all merges upfront (collect `existing.content` + `incoming.content` pairs from a read-only pre-pass, call Flash for each), build a `Map<sectionId, mergedContent>`, THEN open the transaction and apply the pre-computed merges quickly. Loses transactional rollback-on-merge-failure (acceptable since merges already fall back gracefully), but removes connection-hold pressure entirely.
3. Third-order — PgBouncer in transaction-pooling mode in front of the DB. Lets us run a much larger logical pool than the DB's `max_connections` allows. Standard pattern at Supabase scale.

---

## Gemini API rate limits per GCP project

**What:** Google enforces per-project RPM (requests/min) + TPM (tokens/min) caps on every Gemini model. Today everything (ingestion, research, agent-scope, mobile Live, section-merge) flows through one project's quota.

**Why it matters:** At sufficient scale, hitting RPM/TPM means 429 RESOURCE_EXHAUSTED → our retry logic burns through attempts → user-visible ingestion failures during peak periods. We don't currently load-shed at the application level — every backed-up job tries to dispatch.

**Current state:**
- Single GCP project / single API key flowing through `getGeminiClient()` in `packages/shared/src/gemini`.
- `callProWithRetry` in `pro-fan-out.ts` handles 429 / UNAVAILABLE as transient with exponential backoff (2s, 5s, 15s) up to 3 retries.
- Same retry pattern NOT yet on the research handler or section-merge (the latter falls back to append-on-failure; the former has its own narrower retry).

**Trigger conditions:**
- Spike in 429 / RESOURCE_EXHAUSTED Sentry events from `isTransientFetchError` retries.
- Pro fan-out failure rate > ~5% sustained.
- Gemini Cloud Console showing utilization > 80% of project quota.

**Remediation plan:**
1. First-order — file a quota raise request through Google Cloud Console. Free tier RPM/TPM is generous but capped; paid tier increases on request, typically same-day.
2. Second-order — distribute load across multiple API keys / multiple GCP projects. Route by `event_kind`: ingestion on key A, research on key B, etc. Each kind gets its own quota envelope.
3. Third-order — application-level rate limiter (token bucket) BEFORE we call Gemini. Smooths burst load — important if many users wake up at 9am and all trigger morning-recap automations at once.
4. Extend the retry pattern from `callProWithRetry` to the research handler + section-merge for consistency.

---

## Section-merge call inside ingestion commit transaction

**What:** When the commit step encounters a slug collision (PageCreate of a slug that already exists), it switches to merge mode. Sections with title collisions trigger a Flash merge call **inside the open transaction**. Each merge holds the DB connection through the network round-trip.

**Why it matters:** Pure connection-hold issue — see "Postgres connection pool exhaustion" above. Listed separately because there's a clean refactor path specific to this code path.

**Current state:** Merge call lives inside `db.transaction(async (tx) => {...})` in `apps/worker/src/ingestion/commit.ts`. Comment in-line notes this.

**Trigger conditions:** Same as connection-pool exhaustion. Specifically: if telemetry shows long-tail commit durations correlated with merge counts.

**Remediation plan:** See "Postgres connection pool exhaustion" remediation #2 — refactor merges to upfront / pre-transaction. Documented here so the fix has a clear home.

---

## Supabase realtime subscription scaling

**What:** Every mobile client maintains long-lived realtime subscriptions to 5+ collections (wiki_pages, wiki_sections, todos, agent_tasks, research_outputs, call_transcripts). At 100s of concurrent users that's thousands of channels open against Supabase's WebSocket layer.

**Why it matters:** Supabase Pro has concurrent-connection caps (their pricing page says "500 concurrent realtime peak connections" included on Pro; Team has higher). We're at 3 concurrent peak today (just Max + a couple sessions); private-release at 50 concurrent users × 5 channels = 250 — within limit, but with no margin if anyone reconnects in a burst.

**Current state:**
- 5 push-enabled or pull-enabled RxDB collections per user. Each opens its own Supabase realtime channel.
- Current concurrent peak: 3 (per usage screenshot).
- No connection pooling at the channel layer — each collection is its own channel.

**Trigger conditions:**
- Realtime concurrent-connection metric trending above 70% of plan cap.
- Mobile logs surfacing dropped-subscription errors (`PHX_CLOSE` mid-session).
- RxDB sync gaps users report as "I made a change but it didn't show up."

**Remediation plan:**
1. First-order — collapse channels. RxDB can multiplex multiple collection subscriptions onto a single channel via broadcast. Reduces connection count by ~5×.
2. Second-order — push-frequency throttling. Reduces WS message count even if connection count stays.
3. Third-order — upgrade to Team tier or scale plan when peak connections approach included quota.
4. Pairs with the egress audit — the same data-reduction wins on egress also reduce realtime message volume.

---

## Unbounded growth on append-only tables (`call_transcripts`, `usage_events`, `wiki_log`)

**What:** Three tables grow proportional to user activity with no retention policy today. `call_transcripts.content` is JSONB with long-call payloads (50-100 turns × ~200 bytes per turn). `usage_events` writes per inference (multiple rows per call). `wiki_log` writes per ingestion event.

**Why it matters:** At 1000 users × 5 calls/week × 52 weeks, call_transcripts alone hits ~260k rows + ~50 MB JSONB. Combined with usage_events (~10x that row count) and wiki_log (~5x), we're looking at ~$50-100/month of unmanaged storage growth at maturity. Bigger problem: query performance on the Usage dashboard's monthly aggregates degrades linearly with usage_events row count if we don't have the right indexes.

**Current state:**
- All three tables append-only with no rollup or archival.
- Indexes on user_id + created_at exist on the hot-query columns.
- `usage_daily_per_user` view (migration 0011) provides pre-aggregated daily roll-ups for the Usage dashboard, but raw rows are still kept.
- Backlog already has `wiki_log retention / rollup` (P2).

**Trigger conditions:**
- Combined DB size > 1 GB (signaling we're growing into Pro's 8 GB tier).
- Usage dashboard query latency > 500ms (sign of un-indexed scans).
- Supabase backup duration > 5 min (large-table backup pressure).

**Remediation plan:**
1. First-order — archival strategy: rows older than N months move to a separate `*_archive` table per surface, kept for read access via the same dashboards but not in the hot-query path. Halves working-set size on rolling basis.
2. Second-order — Postgres table partitioning by `created_at` (monthly partitions). Native Postgres feature; works well with append-only tables.
3. Third-order — drop `extracted_claims` + `pro_fan_out_response` JSONB columns when audit history isn't load-bearing (or move them to a separate archival store).
4. Refine `usage_daily_per_user` rollup to support YTD queries without scanning the raw `usage_events` table.

---

## Sentry + PostHog event volume cost

**What:** Per-event billing on both services. Today's instrumentation is generous: every transient retry, every ingestion lifecycle event, every spend-cap hit, every usage-event-related capture fires telemetry.

**Why it matters:** Operational cost concern, not a hard ceiling. Sentry's Team plan is ~50k events/month included; PostHog's Cloud plan is ~1M events/month free then per-1M tiers. At 100× user scale, our current pattern produces ~100× event volume. Plan blow-through silently becomes an event-dropping (sampling) issue, which would degrade our forensic ability when we most need it.

**Current state:**
- Sentry capture on every transient Gemini error retry (multiple per failed call), every empty-response capture, every tier-2-crossover, every ingestion-SLA-breach.
- PostHog `capture` events on every ingestion start/skip/succeed/fail/partial/skipped_over_cap, every agent_task lifecycle, every blocked-over-cap event.
- No sampling configured — every event ships.

**Trigger conditions:**
- Sentry plan utilization > 80% in any given month.
- PostHog plan tier creep — moving from free → paid tier when MAU × per-MAU-event-rate crosses threshold.
- Either provider showing "events dropped due to sampling" warnings.

**Remediation plan:**
1. First-order — sample lower-priority events. Transient retries fire MANY events per failed call; sample at 10% (still spots trends; no per-event detail needed). Per-call lifecycle events sample at 100% for failures, 5% for successes.
2. Second-order — first-of-kind dedup per session/user. The 10th tier-2-crossover warning of the day from the same user is the same signal as the 1st.
3. Third-order — Sentry breadcrumbs instead of full captures for non-actionable events. Breadcrumbs are free; they attach to the next real captured event.

---

## In-process rate-limit state on horizontal server scaling

**What:** `@nestjs/throttler` keeps rate-limit counters in process memory (in `apps/server`). If we scale to 2+ server instances behind Render's load balancer, a user can effectively get 2× their rate limit by hitting different instances on consecutive requests.

**Why it matters:** Today (1 server instance) it's airtight — every request hits the same in-process counter. The moment we horizontally scale the server (which we may need to do alongside the worker), throttler quotas effectively double per added instance. For our `/calls/start` (10/hour, 100/day) caps, that means a malicious or runaway user could trivially burst at 2× the documented ceiling. Cost / abuse concern at scale.

**Current state:**
- Single Render server instance. Stateful in-memory throttler counters via `@nestjs/throttler`'s default storage.
- Render's load balancer is sticky-by-default but not guaranteed across reconnects, deployments, or multi-instance scaling events.

**Trigger conditions:**
- We add a second server instance (for redundancy or load).
- Throttler-bypass attempts visible in logs (user hitting limit-cap nearly exactly N/instance-count times).

**Remediation plan:**
1. First-order — Redis-backed `@nestjs/throttler` storage. Render offers managed Redis. One-time wiring; rate-limit state then lives outside any individual server process. Cost: ~$5/mo Render Redis tier.
2. Second-order — DB-backed rate-limit counters. Cheaper (no Redis) but adds DB write pressure on the auth hot path. Probably not worth the complexity tradeoff vs. Redis.

---

## Auth-guard DB roundtrip on every API request

**What:** `apps/server/src/auth/supabase-auth.guard.ts` runs a tombstone-check query against `user_settings` on every authenticated request (verifies the user hasn't been deleted between JWT issuance and now).

**Why it matters:** Adds ~5-10ms latency tax to every API request + a DB connection-pool checkout. At 10 RPS per user × 1000 active users that's 10k QPS for the tombstone-check alone — significant load on a pool sized for ingestion's needs (50-ish connections).

**Current state:**
- Every authenticated request hits the guard, which does the lookup.
- No caching layer.

**Trigger conditions:**
- DB connection-pool utilization correlated with API request rate.
- P99 API latency creeping > 100ms during peak periods, traceable to guard time.

**Remediation plan:**
1. First-order — in-process LRU cache, 60s TTL, keyed on user_id. Tombstoning a user is rare enough that 60s stale data is acceptable. Cuts the lookup to one DB hit per user per minute.
2. Second-order — push tombstoning into the JWT claims via Supabase auth hooks. Then the guard just checks the JWT without any DB call. Bigger refactor; worth it at much-higher scale.
3. Third-order — Redis-backed cache (same Redis instance as #4 above). Lets multiple server instances share the cached decisions.

---

## How to use this doc

- New entries land here when we identify a future bottleneck during feature work. Keep the shape consistent (what / why / current state / triggers / remediation).
- When telemetry says an entry's triggers have fired, the remediation plan is the starting point for execution.
- Closed bottlenecks (truly addressed at scale) get moved to a "Resolved" section at the bottom rather than deleted, so we keep the institutional knowledge of what we fixed and when.
