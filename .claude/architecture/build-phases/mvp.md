# Build plan — MVP

Execution roadmap for getting from spec to running app. Each slice is a runnable end-to-end demo; we don't move to the next slice until the current one is genuinely working (not just compiled).

This is a sequencing tool, not a spec. Implementation details get figured out at code time. The point: avoid getting tangled by knowing what the next demoable thing is at every step.

**Legend**

- ✅ — done
- ✴️ — partial / in progress (e.g. account created but not yet wired into env)
- ⏺️ — open / not started
- ⛔ — blocked on something external (dependency noted inline)

---

## Pre-flight (before slice 0)

External accounts + access provisioned. Every item is "needs to exist before we can write code that depends on it":

- ✅ Supabase project — `Audri (dev)`, single instance for MVP. Dev/prod split deferred (see `backlog.md` → Environments)
- ✅ Gemini API key (Studio account; access to Live + Pro + Flash + explicit caching) — in `.env.local`
- ✴️ EAS account — created + project stubbed; not yet wired into env
- ✴️ Render account — created; services not yet provisioned (planned for slice 0b)
- ✴️ Sentry account — created; client + server projects + DSNs pending
- ✴️ PostHog account — stubbed; API key + feature-flag setup pending
- ⛔ Apple Developer Program enrollment — Individual Enrollment blocked on Apple support reply. Workaround: focus on local development; deployments wait on resolution
- ✴️ Google Cloud project + OAuth client — login created + project started; OAuth client not yet configured
- ✅ Domain name — `talktoaudri.com` registered

Roughly half-day of admin work, mostly waiting on confirmation emails.

---

## Slice 0 — Workspace bootstrap

**Goal:** every package has a hello-world that runs.

**2026-04-26 sequencing change** (per `judgement-calls.md`): split into 0a (server+worker locally) → 0b (Render deploy) → 0c (mobile bootstrap). RxDB validation spike deferred to 0c.

### 0a — Server + worker locally (✅ done 2026-04-26)
- ✅ pnpm workspace at repo root
- ✅ `apps/server/` — NestJS init; minimal `GET /health` returning 200; pino structured logging; Sentry stub
- ✅ `apps/worker/` — plain Node + graphile-worker connected to **cloud Supabase** (no local CLI); logs a heartbeat every 30s; Sentry stub
- ✅ `packages/shared/` — TypeScript package compiled to `dist/`; consumed by both apps
- ✅ Biome + base tsconfig at root, extended per-app
- ✅ Drizzle initialized against cloud Postgres
- ✅ **First migration: full data model in one shot.** All 17 MVP tables, 10 enums, ~30 FKs (incl. cross-schema to `auth.users`), ~30 indexes (btree, GIN with `jsonb_path_ops`, tsvector, partial WHERE), 4 triggers, RLS enabled on all (no policies until slice 9). Schema design doc at `specs/db-schema-plan.md`.

### 0b — Render deploy (✅ done 2026-04-26)
- ✅ `render.yaml` Blueprint; both services on `starter` plan ($14/mo total), `oregon` region
- ✅ `audri-server` live at `https://audri-server.onrender.com` — `/health` returns 200
- ✅ `audri-worker` live, processing heartbeats against cloud DB
- ✅ Build pipeline: `pnpm install --frozen-lockfile && pnpm --filter @audri/{name}... build` then `pnpm --filter @audri/{name} start`
- ✅ Auto-deploy on push to default branch
- ✅ `EXPO_PUBLIC_API_URL` set in `.env.local` to live Render URL

### 0c — Mobile bootstrap (✅ done 2026-04-26)
- ✅ `apps/mobile/` — Expo SDK 54 + Expo Router with `(auth)` + `(app)` route groups; hello-world home placeholder rendering Azure theme
- ✅ Metro configured for pnpm monorepo (watchFolders + nodeModulesPaths + disableHierarchicalLookup) + NativeWind v5 wrapper
- ✅ NativeWind v5 preview + Tailwind v4 + PostCSS pipeline live; Azure theme tokens defined in `global.css`
- ✅ Cross-package `@audri/shared` import working from mobile
- ✅ `apps/mobile/.env.local` for `EXPO_PUBLIC_*` (Expo reads from project dir, not monorepo root)
- ✅ **RxDB + Supabase replication validation spike** — RxDB 14.x + rxdb-supabase 1.0.4 + memory storage. Construct against cloud schema succeeds. Real wiring (expo-sqlite + RLS-aware auth + full collection set) lands in slice 5.
- ✅ Verified on iOS via Expo Go

**Demo:** server `/health` 200 from public Render URL. Worker logs heartbeat in Render's log viewer. Cloud Postgres has all MVP tables. Mobile boots to home placeholder showing app name + shared-package name + API URL + RxDB spike result.

**Estimated:** 3–5 days. Actual: entire Slice 0 in 1 day.

---

## Slice 1 — Auth → Home reachable (✅ done 2026-04-27)

**Goal:** complete signup flow lands the user on a home screen with their seeded data visible.

- ✅ Mobile: **Google sign-in via Supabase Auth** (PKCE flow, `signInWithOAuth` + `WebBrowser.openAuthSessionAsync` + `exchangeCodeForSession`). Apple sign-in deferred — P0 in `backlog.md`.
- ✅ Server: Supabase **Database Webhook** on `auth.users` INSERT → `POST /webhooks/supabase-signup` (auth via `Authorization` header secret) → SeedService transaction → 1 agent + 20 wiki_pages (5 agent + 10 profile + 5 todo) + 1 user_settings. Idempotent on user_id. Deferrable circular FK between `agents.root_page_id` ↔ `wiki_pages(agent root).agent_id` worked as designed.
- ✅ Mobile: `useSession` hook + reactive route gates in `(auth)/_layout` and `(app)/_layout`.
- ✅ Mobile: Home screen shell — wordmark, time-aware greeting + first name from Supabase Auth `user_metadata.given_name`, sign-out tile (avatar stub), 2x2 plugin grid placeholder, phone FAB. SafeAreaProvider + edge-to-edge bg.
- ✅ Server: `GET /me` (auth-guarded by `SupabaseAuthGuard`, returns `{ user, agents (sanitized — no persona_prompt per Invariant 3), userSettings }`).

**Demo (validated live):** sign in with Google → user row created in `auth.users` → webhook fires → seed runs → mobile lands on home with "Good morning, Max." + "1 agent · 1 plugin".

**Estimated:** 4–6 days. **Actual:** ~4 hours of code + ~2 hours of OAuth-config debugging.

**Punted from this slice (logged elsewhere):**
- iOS `ASWebAuthenticationSession` system dialog ("Audri wants to use ...supabase.co to Sign In") — UX-confusing but unavoidable without paid Supabase Pro custom auth domain or native Google Sign-In SDK. Tracked in `backlog.md` Security section.
- Apple sign-in (Apple Developer enrollment blocked).

---

## Slice 2 — Call screen skeleton (stubbed Gemini) (✅ done 2026-04-27)

**Goal:** the call experience VISUALLY works end-to-end. Audio is fake.

- ✅ Mobile: `(app)/call.tsx` — orb + M:SS elapsed timer + hang-up + Connecting state
- ✅ Mobile: home phone FAB → routes to /call → returns home on hang-up
- ✅ Mobile: simplified orb component (single circle, Reanimated `interpolateColor` cross-fade between blue/indigo on speaker change). Initial design (breathing + glow + amplitude scale) was visually rough; reverted to sandbox-style single-circle. Re-attach amplitude reaction in slice 3 if needed.
- ✅ Mobile: `<CallEndedDropped>` component reachable via 4-tap debug toggle on the orb
- ✅ Mobile: Zustand `useCallStore` at module scope (status, currentSpeaker, amplitude, transition actions)
- ✅ Mobile: hang-up triggers ending → reset → router.back

**Demo (validated live):** tap phone on home → call screen mounts → "Connecting…" → M:SS timer + orb cross-fades on fake speaker cycle → hang-up returns home.

**Estimated:** 3–4 days. **Actual:** ~1 hour code + ~30min orb iteration.

---

## Slice 3 — Real Gemini Live wiring (✅ done 2026-04-27)

**Goal:** actual conversation with Audri. Transcripts persist. No ingestion yet.

- ✅ Server: `POST /calls/start` mints **ephemeral Gemini Live token** via `ai.authTokens.create({ liveConnectConstraints: ... })`. Persona + voice + system instruction + server-side VAD config locked into token; client never sees raw API key OR persona text. Returns `{ sessionId, ephemeralToken, model, voice }`.
- ✅ Mobile: client decodes ephemeral token → `ai.live.connect({ model })` → direct WebSocket to Google
- ✅ Mobile: real mic audio (PCM16 16kHz mono) streams through; **peak amplitude** drives orb glow + barge-in trigger (peak proved 5x more discriminating than RMS)
- ✅ Mobile: turn-tagged transcript via `inputAudioTranscription` + `outputAudioTranscription` Gemini config
- ✅ Server: `POST /calls/:sessionId/end` updates the pre-existing `call_transcripts` row. Idempotent — re-fire returns `already_ended`. Pre-creation at /start gives transcript a row to attach to even if /end fails.
- ✅ **Barge-in working.** Mic-gate during playback prevents echo loop; peak-amp threshold (0.06, sustained 100ms) detects user voice through both phone speaker echo AND ambient noise (verified live with loud music in background — only voice triggers).
- ✅ Server: stub persona prompt in `seed.constants.ts` (friendly, warm, brief). Real persona text in Slice 6.

**Module split (apps/mobile/lib/gemini/):** `session.ts` (transport), `audio-input.ts` (mic + gate), `audio-output.ts` (PCM playback queue + per-buffer onEnded for finality), `transcript.ts` (turn builder), `useCall.ts` (orchestrator), `audio-utils.ts` (PCM helpers + peakAmplitude).

**Demo (validated live):** sign in → tap phone → conversation with Audri → mid-utterance interruption works at normal speaking volume → hang up → call_transcripts row has full turn-tagged transcript.

**Estimated:** 5–7 days. **Actual:** ~3 hours code + ~1 hour barge-in tuning. Barge-in was the wildcard but converged once we switched RMS → peak amplitude.

---

## Slice 4 — Ingestion pipeline (✅ done 2026-04-27)

**Goal:** transcripts auto-fan-out into wiki content. Validate by SQL queries.

- ✅ Worker: Graphile Worker with per-user `queue_name` for ingestion (`ingestion-${user_id}`); separate non-queued generate_title_summary task; conservative retry (max_attempts=2 ingestion, 3 title-summary).
- ✅ Worker: ingestion job handler — reads transcript, runs Flash candidate retrieval (real Gemini call) → Pro fan-out (real Gemini call, gemini-3.1-pro-preview) → transactional commit (sectioned writes + source junctions + wiki_log kind='ingest').
- ✅ Worker: Flash + Pro prompts drafted as substantial system prompts per `specs/flash-retrieval-prompt.md` + `specs/fan-out-prompt.md`. Iteratively tuned during slice — Pro prompt's "atomic claims" framing was widened to also capture frameworks, theories, extended reasoning + section-content depth guidance.
- ✅ Server: `POST /calls/:session_id/end` enqueues ingestion + title-summary jobs atomically with transcript commit via `graphile_worker.add_job` in same Drizzle transaction.
- ✅ Worker: agent-scope ingestion pass runs in parallel via `Promise.allSettled` per `specs/agent-scope-ingestion.md`. Single Flash call; writes observations to active agent's subtree (`scope='agent'`, `agent_id`); wiki_log kind='agent_scope_ingest'. Independent failure isolation — one pass's failure doesn't block the other.
- ✅ Server: title/summary moved from in-process fire-and-forget into Graphile (kind='generate_title_summary') for durability + retries.
- ✴️ Gemini explicit caching for scaffolding — **deferred to backlog** (P1, Cost/Infra). At MVP volume the savings is cents/day vs. ~1-2 hrs of cache lifecycle infra; revisit when daily call volume crosses ~50/day.

**Pre-slice infra also shipped:**
- `packages/shared` extracted to hold Drizzle schema + db client + Gemini client. Worker now consumes the same schema as server; future plugins (research in slice 7) inherit this.

**Demo (validated live 2026-04-27):** 7-min call about Consensus project → 3 interlinked pages (consensus project + interdependence concept + social-technology concept) × 6 specific-titled sections with markdown formatting + transcript citations. Multi-target routing working; user's distinctive phrasing ("scaling of human alignment", "interdependence is not the same thing as cooperation") preserved.

**Estimated:** 7–10 days. **Actual:** ~6 hours of code + ~1 hour of pooler/billing/prompt tuning.

---

## Slice 5 — RxDB sync + Wiki plugin surface (✅ done 2026-04-27)

**Goal:** mobile reactively reflects server-side wiki changes. First "real" plugin overlay UX.

- ✅ Mobile: RxDB setup with Supabase replication plugin (in-memory storage MVP; collections for `wiki_pages` + `wiki_sections`). `_deleted` GENERATED column derived from `tombstoned_at` so rxdb-supabase has its required tombstone signal.
- ✅ Mobile: RxDB hydration via paginated pull on `updated_at`.
- ✅ Mobile: `<PluginOverlay>` + `usePluginOverlay()` rebuilt — origin-aware scale-from-tile animation (captures tile rect via `measureInWindow`, animates left/top/width/height/borderRadius). Sheet unmounts after close-animation completes so it doesn't sit over the tile when collapsed; opacity fade on the leading + trailing edges of the animation.
- ✅ Mobile: 4-column tile layout with label below tile (replaced 2x2 in-tile-label grid).
- ✅ Mobile: Wiki overlay → folder list (virtual folders by `type`) → page list → page detail with markdown rendering + raw-markdown section editor.
- ✅ Mobile: realtime sync working — required hand-edited migration to enroll `wiki_pages` + `wiki_sections` in `supabase_realtime` publication and set `REPLICA IDENTITY FULL` (Slice 6 follow-up; rxdb-supabase subscribes successfully but receives no events without publication membership).
- ✅ Mobile: `startReplication()` memoizes its in-flight promise so concurrent mounts (StrictMode, multiple consumers) don't construct duplicate replications against the same realtime channel.

**Estimated:** 5–7 days. **Actual:** ~1 day code + ~2 hrs of RxDB schema gotchas (maxLength on indexed string fields, _deleted column) + ~1 hr Supabase realtime publication.

---

## Slice 6 — Onboarding end-to-end (✅ done 2026-04-27)

**Goal:** new user signup flows naturally through onboarding into a populated profile.

- ✅ Mobile: `(app)/onboarding.tsx` screen — pre-state with welcome copy + "Tap to begin" + "Skip for now"; live state reuses orb + hangup, then `router.replace('/(app)')` on end.
- ✅ Server: `composeSystemPrompt` branches by `call_type`. Onboarding scaffolding implements `specs/onboarding.md` — self-intro template, life-history-first opener (with interests-pivot if life-history is a dead-end), askable/emergent topic split, capability-advertisement discipline tied to stated needs, ~10-min "good-enough" wrap heuristic, "breadth over depth without disrupting flow" guidance.
- ✅ Server: `/calls/:id/end` flips `user_settings.onboarding_complete=true` atomically with the transcript update for non-cancelled onboarding calls.
- ✅ Mobile: home screen redirects first-time users (`onboardingComplete=false` from `/me`) to `/onboarding`. Subsequent loads land on home as normal.
- ✅ Mobile: `useCall.start({ callType })` plumbs the type through to `/calls/start`; kickoff cue distinguishes onboarding vs generic.
- ✅ Seed: agent name flipped from `'Assistant'` to `'Audri'` (slug stays `'assistant'`) so the model self-identifies correctly.
- ✅ Worker: Pro fan-out wrapped with single transient-error retry (undici headers timeout, fetch failures) so one slow Pro response doesn't kill the user-scope ingestion pass.
- ✅ Generic-call context preload — `loadGenericCallContext()` reads profile/* + agent-scope notes (`assistant/observations|recurring-themes|preferences-noted|open-questions`) + last 5 ended call titles+summaries + 8 most-recently-updated wiki pages, rendered as a "What you know about the user" markdown block injected into the system prompt for `call_type='generic'` only. Per-section character caps prevent verbose profiles from blowing context. Onboarding stays cold (no preload — user hasn't given the model anything yet).

**Estimated:** 4–6 days. **Actual:** ~2 hours code + ~1 hour prompt iteration. Onboarding flow felt right after 2-3 prompt revisions; the most subtle one was rewriting the "breadth over depth" rule after it caused the model to cut users off mid-thought.

---

## Slice 6.5 — Resilience (call ingestion failure modes) (✅ code done 2026-04-28; migration pending DNS)

**Goal:** stop bleeding ingestion failures. Surface partial / failed state to the user + the conversational agent so dropped or broken calls don't disappear.

- ✅ Mobile: AsyncStorage-backed `CallSnapshot` written on every transcript change during a call (`apps/mobile/lib/callRecovery.ts`). Cleared on clean `/end`. Survives force-quit / crash.
- ✅ Mobile: AppState `'background' | 'inactive'` handler in `useCall` — when iOS suspends a connected call, tear down audio + POST `/calls/:id/end` with `end_reason='app_backgrounded'` and the cached transcript. Snapshot stays on disk if the recover-POST fails so the launch sweep can retry.
- ✅ Mobile: `useCallRecoverySweep` runs once per signed-in transition (mounted on the home screen). Reads any orphaned snapshot, POSTs `/end` with `end_reason='network_drop'` if stale (>5min since `lastTouched`), clears on success.
- ✅ Schema: `ingestion_status` enum (`pending` / `running` / `succeeded` / `failed`) + `ingestion_error` text on `call_transcripts` (migration `0008_ingestion_status.sql` written; pending apply due to local DNS issue with the IPv6-only direct host).
- ✅ Worker: ingestion writes 'running' at start, 'succeeded' / 'failed' at terminal state. Failed status carries `ingestion_error` for diagnostics.
- ✅ Server: `POST /calls/:sessionId/retry-ingest` re-enqueues a failed transcript; idempotent — only fires when current status is 'failed'.
- ✅ Server preload: `loadGenericCallContext` now surfaces the most recent non-user-ended call within 24h via a new "Last call cut off" section, with reason + previously touched slugs (read from `wiki_log`). Generic scaffolding gets a "open by briefly acknowledging this and offering to pick up — don't insist" guidance line.
- ⏺️ Mobile: Wiki/Activity surface shows ingestion-failed calls with a manual retry button → `POST /calls/:id/retry-ingest`. **Punted to slice 8** since that's where the proper Activity / call-history UI lands.
- ⏺️ Worker: more retry-tolerant Pro fan-out (idempotency keys to avoid duplicate sections on retry; bumped `max_attempts`). **Deferred** — only worth doing once we see retries actually causing duplicate sections in the wild; today's max_attempts=2 with the single-shot transient-error retry inside `runFanOut` is good enough.

**Demo (achievable once migration applies):** kill the app mid-call → relaunch → orphan sweep auto-submits the transcript → ingestion runs → next call opens with "looks like our last call got cut off — want to pick up?"

**Estimated:** 1–2 days. **Actual:** ~2 hours of code; pending the migration apply.

---

## Slice 7 — Research plugin end-to-end (✅ done 2026-04-27)

**Goal:** first agent_task kind shipped. User can request research and get a result.

- ✅ Worker: `agent_task_dispatch` Graphile task pulls a queued `agent_tasks` row by id, marks running, dispatches by kind, on terminal failure marks `failed` + records `last_error`. Plugin registry already had `research` entry; handler now wired in.
- ✅ Worker: research handler (`apps/worker/src/research/handler.ts`) — Pro call (`gemini-3.1-pro-preview`) with `tools: [{ googleSearch: {} }]` for grounded search. JSON output validated via zod (`ResearchOutputZ`). Prompt instructs aggressive grounding, citation discipline, length/depth, voice, refusal rules per `specs/research-task-prompt.md`.
- ✅ Worker: research commit helper writes `research_outputs` + `research_output_sources` + flips `agent_tasks.status='succeeded'` + reparents originating todo wiki page → `todos/done` + emits `usage_events(plugin_research)` + `wiki_log(task)` — all in one transaction.
- ✅ DB: migration `0004_research_rls_realtime.sql` adds RLS SELECT policies on `research_outputs` + `research_output_sources` + `research_output_ancestors`, `_deleted` GENERATED column on `research_outputs`, `REPLICA IDENTITY FULL`, and enrolls `research_outputs` in `supabase_realtime` publication. Migration `0005_research_citations_jsonb.sql` adds a denormalized `citations` JSONB column on `research_outputs` so the mobile detail view can render footnotes without joining a second collection.
- ✅ Server: `POST /tasks/research` endpoint — creates the originating todo wiki page + agent_tasks row + enqueues the dispatch job in one transaction. Used for the explicit "spawn research" affordance from the mobile UI.
- ✅ Mobile: RxDB `research_outputs` collection + replication wiring + `useResearchOutputs` hook (sorted by `generated_at` desc).
- ✅ Mobile: ResearchOverlay (list + spawn affordance + detail navigation) + ResearchOutputDetail (query, summary, findings with citation indices, follow-up questions, clickable citations panel). Mounted at app root alongside WikiOverlay; Research plugin tile on home wired with origin-aware open animation.
- ✅ Worker: ingestion auto-creates research tasks. Pro fan-out prompt got a new `## 9. Research-intent extraction` section + `tasks` field on the response schema. `commitFanOut` extends the transaction to insert the tracking todo + agent_tasks row + Graphile dispatch job per extracted task.

**Demo (achievable):** in a call, "can you research Italian restaurants in lower Manhattan?" → call ends → ingestion's Pro fan-out detects the research commitment → research handler runs Pro+grounded-search → 1-3 min later the Research overlay shows the new output with citations.

**Estimated:** 6–8 days. **Actual:** ~3 hours of code. Heaviest pieces were the handler prompt and the schema/replication plumbing for a new RxDB collection.

---

## Slice 8 — Todos + Profile plugin surfaces (✅ done 2026-04-28)

**Goal:** all 4 MVP plugin tiles functional.

- ✴️ **Decision point: introduce `todos` sidecar table** — not triggered yet; current Todos overlay rides pure wiki_pages without typed columns. Land when the first feature needs an indexed query against `due_date`/`priority`/etc.
- ✅ Mobile: Todos plugin overlay (`components/todos/TodosNavigation.tsx`)
  - Projection over `wiki_pages WHERE type='todo'` joined live with active `agent_tasks`
  - Status tabs (To do / In progress / Done / Archived) with per-bucket counts
  - Check-off → reparent via direct RxDB `.patch()` on `parent_page_id` (RLS already permits user-scope page UPDATEs)
  - **Running** agent_task status surfaced inline: row checkbox swaps for a spinner + "Researching now / Queued · usually 1–3 min" subtext
  - Manual create-todo affordance via new `POST /todos` endpoint (RLS gates client INSERT on wiki_pages)
- ✅ Mobile: Profile plugin overlay (`components/profile/ProfileNavigation.tsx`) — browse profile root + 9 children, markdown render via `WikiPageDetail`, edit affordance on user-scope pages
- ✅ Bonus (P0 backlog item, landed proactively): **Pending-artifact placeholders pattern**
  - Migration `0009_agent_tasks_rls_realtime.sql` enables RLS + realtime + `_deleted` on `agent_tasks` (applied 2026-04-28 via pooler)
  - New `agent_tasks` RxDB collection + replication + `useActiveAgentTasks(kind)` hook
  - Research overlay shows pending tasks pinned at top of list with spinner; Todos overlay shows live state on the matching todo row

**Punted to V1+ (logged in `backlog.md`):**
- Sub-tasks via hierarchy rendering (P2)
- Failed agent_task surfacing on todo rows (P1)
- Failed-ingestion retry UI button (P1; endpoint exists)
- Greeting-subtext live-activity reflection (P3)

**Demo:** finish a call with commitments → see the in-flight research as a pending row in Research overlay AND as a spinner on the matching Todos row → research completes → row swaps to checkbox + research artifact appears in Research overlay. View profile pages and edit.

**Estimated:** 4–6 days. **Actual:** ~3 hours. The pending-placeholder pattern was the most interesting design moment — tied agent_tasks sync to the existing RxDB infra cleanly.

---

## Slice 9 — Pre-launch hardening (✅ done 2026-04-29)

**Goal:** the thing is shippable.

- ✅ Server + worker: full RLS policy set per `todos.md` §3 RLS draft (migration `0010_rls_hardening.sql`). Coverage: wiki_section_history/transcripts/urls/ancestors (SELECT via parent), agents (SELECT own + column-level REVOKE on persona_prompt + user_prompt_notes), call_transcripts, wiki_log, tags, wiki_page_tags, usage_events, user_settings.
- ✴️ Server: cross-agent leakage tests — **scaffold only** (`apps/server/src/__tests__/rls-leakage.test.ts`). Vitest install + wired test Supabase punted to V1 per `backlog.md > Currently outstanding`.
- ✅ Server: rate limiting via `@nestjs/throttler` with a user-keyed guard. Per-user caps: calls 10/hr + 100/day; research 20/hr + 80/day; default 30/min + 500/day on everything else. Health + webhooks bypassed.
- ✅ Server: `DELETE /me` account tombstone. Sets `user_settings.tombstoned_at`, revokes Supabase sessions globally; auth guard rejects subsequent requests with 403. Data left intact; hard-delete + data export V1+.
- ✅ Sentry integration **fully validated 2026-04-29** across all three projects: server (NestJS `SentryExceptionFilter` global filter, smoke-tested via `/health/sentry-test`), worker (graphile tasks wrapped with `withSentry()`, organic capture validated), mobile (`@sentry/react-native` with DSN-gated init, smoke-tested via long-press handler that was later removed). `instrument.ts` ordering fix on server per Sentry SDK v8 requirements. Mobile source-map upload via EAS secrets `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT`; end-to-end source-map verification still pending first organic prod crash.
- ✅ CI pipeline (`.github/workflows/ci.yml`): typecheck (all workspaces) + biome lint + drizzle journal/file-existence sanity check. Manual-only EAS builds per `feedback_eas_builds_manual_only.md` memory.
- ✅ Cost monitoring SQL views (`0011_usage_events_views.sql`): `usage_daily_per_user` + `usage_daily_by_kind`. Sample queries in the migration's leading comment.
- ✅ PII redaction expansion in pino: server + worker now redact `transcript`, `content`, `query`, `summary`, `payload`, `snippets`, `findings`, `notes_for_user`, `context_summary` at both top-level and nested paths.
- ✅ **PostHog wiring + kill switches** (2026-04-29): `posthog-node` singleton in `@audri/shared/posthog` with fail-open `isFeatureEnabled()` semantics. Kill-switch flag checks at ingestion entry (`ingestion_enabled`) + agent-task dispatch entry (`<kind>_enabled`, e.g. `research_enabled` — extensible to future plugin kinds). Lifecycle events captured: `ingestion.started/succeeded/failed/skipped_by_flag` + `agent_task.started/succeeded/failed/skipped_by_flag`. SIGTERM handler flushes the buffer on graceful shutdown. Verified end-to-end via PostHog Live Events.
- ✅ **EAS Build configured + first TestFlight release live (2026-04-29)** — bundle ID `com.talktoaudri.audri`, build `0.1.0 (1)` via `pnpm testflight`. App Store Connect API key auto-managed by EAS. Production build uses background-audio entitlement (`UIBackgroundModes: ["audio"]`) so calls continue when the device is locked / app backgrounded — the user-facing phone-call model.
- ✴️ Render staging environment — punted to V1 per Max 2026-04-29; single environment for closed beta. See `backlog.md > Environments`.
- ✴️ Supabase dev/prod project split — punted to V1 per Max 2026-04-29; same source as above.

**Demo (validated 2026-04-29):** TestFlight install → onboarding flow → first generic call → research auto-spawns from in-call request → wiki populates over multiple calls → resilience flow recovers force-quit calls (manual test 2026-04-29 confirmed: kill app mid-call → relaunch → snapshot recovery → next call references prior topic). All four MVP plugin tiles functional (Wiki, Research, Profile, Todos). Sentry capturing all three platforms; PostHog capturing lifecycle events and gating kill switches.

**Estimated:** 7–10 days. **Actual:** ~3 hours of code spread across two days; the long pole was external setup (Apple Developer enrollment, Sentry project DSN debugging, EAS Build flow, App Store Connect auth).

---

## MVP code-complete (2026-04-29)

**Status: closed.** The full slice 0–9 plan landed end-to-end in roughly two weeks of focused work. Audri is on TestFlight (`com.talktoaudri.audri` 0.1.0), every demo path validated on real hardware, telemetry flowing on three platforms.

**What shipped:**
- Voice-first call experience (Gemini Live, barge-in, transcription, lock-screen-persistent calls)
- Onboarding flow with life-history-first opener, askable/emergent topic split, ~10-min good-enough heuristic
- Ingestion pipeline (Flash candidate retrieval → Pro fan-out → transactional commit → agent-scope side pass) with per-user FIFO graphile queue
- Generic-call context preload (profile + agent notes + recently-active wiki pages + incomplete-call hint)
- Four plugin surfaces: Wiki (folders + page detail + raw-markdown editor), Research (Pro + Google grounded search, citations, hyperlinks), Profile (sectioned overview), Todos (status-bucket tabs, check-off, manual create)
- Per-plugin React Navigation stack with native push/pop + slide animations
- Pending-artifact placeholder pattern (in-flight agent_tasks render as live rows)
- Resilience layer: AsyncStorage-backed call snapshot, app-launch orphan sweep, ingestion_status enum, retry endpoint
- Hardening: full RLS coverage with column-level redaction on agents, per-user rate limiting, account tombstone, PII-redacted logs, cost-monitoring views
- Telemetry: Sentry on server/worker/mobile, PostHog with kill-switch feature flags
- Distribution: TestFlight build with background-audio entitlement, source-map upload wired

**What's V1 (carried in `backlog.md > Currently outstanding`):**
- Apple Sign-in (deferred from slice 1 during enrollment block — now unblocked, V1 task)
- Mobile Sentry source-map upload validation (waiting on first organic prod crash)
- Vitest test runner + cross-agent leakage tests
- Render staging environment + Supabase dev/prod split
- WYSIWYG section editor
- Plugin overlay swipe-up gesture handling

**The build-plan doc is now an artifact, not a todo list.** Refer to `backlog.md` for the V1+ horizon.

---

## Total estimate

50–75 days of focused work. Roughly 2–3 months at sustainable pace.

This assumes solo (the user) coding with Claude assist + no rabbit holes. Real-world numbers will fluctuate. Anchors to renegotiate against rather than commitments.

---

## What we DON'T build at MVP (explicitly punted to V1+)

Cross-referenced in `backlog.md`:

- Connectors (Gmail / Calendar / Contacts) — no MVP plugin needs them
- Push notifications
- Custom agents beyond the default Assistant
- Skills (context-aware capability suggestions)
- Trial artifacts during onboarding
- Theme switcher + light-mode toggle (tokens defined, switcher V1+)
- Avatar account/settings menu (stub at MVP)
- Mic-mute UI on call screen
- In-call transcript feed
- Podcast / Email / Calendar / Brief plugins (artifact tables exist but plugins don't ship)
- Re-ingestion of artifacts back into wiki
- Embedding pipeline (pgvector)
- Distributed tracing
- Aggregate failure-rate alerts
- Pricing model + tier gating enforcement
- Activity stream UI polish (basic version exists; rich V1+)
- Most KG-maintenance background flows (auto-split, entity merge, broken-wikilink repair)
- Graph view UI

---

## How to use this plan

1. Don't move to slice N+1 until slice N has a working demo. The demo is the truth.
2. If a slice eats more than 1.5x its estimate, stop and reflect: is there a hidden complexity we should descope or punt?
3. Each slice's first commit on a feature branch should be a runnable skeleton (even if stubbed) before depth fills in. Iterate breadth-first within a slice to keep demos shippable.
4. When a slice surfaces a decision not covered in spec, log it in `judgement-calls.md` with the rationale.
5. The pre-flight account list is a one-pass gate — don't try to start slice 0 without those done; you'll get blocked mid-slice.
