# Build plan — MVP

Execution roadmap for getting from spec to running app. Each slice is a runnable end-to-end demo; we don't move to the next slice until the current one is genuinely working (not just compiled).

This is a sequencing tool, not a spec. Implementation details get figured out at code time. The point: avoid getting tangled by knowing what the next demoable thing is at every step.

---

## Pre-flight (before slice 0)

External accounts + access provisioned. Every item is "needs to exist before we can write code that depends on it":

- [ ] Supabase project (one for dev, one for staging eventually)
- [ ] Gemini API key (Studio account; access to Live + Pro + Flash + explicit caching)
- [ ] EAS account (Expo Application Services)
- [ ] Render account (for `apps/server` + `apps/worker` deploys)
- [ ] Sentry account (free tier; client + server projects)
- [ ] PostHog account (analytics + feature flags)
- [ ] Apple Developer Program enrollment (for Apple sign-in + TestFlight)
- [ ] Google Cloud project + OAuth client (for Google sign-in)
- [ ] Domain name (eventually — not blocking)

Roughly half-day of admin work, mostly waiting on confirmation emails.

---

## Slice 0 — Workspace bootstrap

**Goal:** every package has a hello-world that runs.

- [ ] pnpm workspace at repo root
- [ ] `apps/mobile/` — Expo init; NativeWind setup; Expo Router scaffolding; theme tokens stubbed (Azure-only); status bar default; "hello world" home placeholder
- [ ] `apps/server/` — NestJS init; minimal `GET /health` returning 200; pino structured logging; Sentry stub
- [ ] `apps/worker/` — NestJS or plain Node entry; Graphile Worker connected to local Supabase Postgres; logs a heartbeat every 30s; Sentry stub
- [ ] `packages/shared/` — TypeScript package; exports a placeholder type; consumed by both mobile + server
- [ ] Biome + Prettier-Tailwind plugin + base tsconfig at root, extended per-app
- [ ] Supabase CLI running locally (`supabase start`); Drizzle initialized against local Postgres
- [ ] **First migration: full data model in one shot.** Every MVP table, every column, every index, every RLS policy stub (real RLS lands in Slice 9). 20+ tables. Done as one carefully-reviewed migration so we don't evolve schema iteratively under us. Generated `packages/shared/db.ts` types from this.
- [ ] **Validation spike (~½ day):** RxDB + Supabase replication plugin against the local schema. Stand up one collection, validate two-way sync works with RLS. Cheap insurance against a Slice 5 disaster.

**Demo:** all three apps boot. Mobile loads to a blank home placeholder. Server responds 200 to health. Worker logs heartbeat. Local Postgres has all MVP tables.

**Estimated:** 3–5 days.

---

## Slice 1 — Auth → Home reachable

**Goal:** complete signup flow lands the user on a home screen with their seeded data visible.

- [ ] Mobile: Apple sign-in + Google sign-in via Supabase Auth (`@supabase/supabase-js` + `expo-apple-authentication` + Google equivalent)
- [ ] Server: signup webhook from Supabase Auth → seed transaction (1 `agents` row + 20 `wiki_pages` rows + 1 `user_settings` row, atomic, idempotent)
- [ ] Mobile: routing gate — `(auth)` redirect away if authed; `(app)` redirect to `(auth)` if unauthed
- [ ] Mobile: Home screen shell — wordmark, greeting (time-aware), avatar stub, plugin grid placeholder (4 tiles: Wiki / Todos / Research / Profile), phone-icon button at bottom. Tiles do nothing yet; phone button does nothing yet.
- [ ] Server: minimal `GET /me` endpoint returning `{ user_id, agents[], user_settings }` for client bootstrap (RxDB comes in Slice 5; this is REST for now)
- [ ] Mobile: full-screen edge-to-edge background; safe-area insets respected for layout

**Demo:** sign in with Apple → server seeds wiki → mobile lands on home → home renders with personal greeting. No call yet, no plugin contents yet.

**Estimated:** 4–6 days.

---

## Slice 2 — Call screen skeleton (stubbed Gemini)

**Goal:** the call experience VISUALLY works end-to-end. Audio is fake.

- [ ] Mobile: `(app)/call.tsx` — orb animation, hang-up button, "Connecting..." state
- [ ] Mobile: home phone-icon button → routes to call; on call end, returns to home
- [ ] Mobile: Reanimated-based orb component
  - Idle breathing animation
  - Audio-level-driven scale + glow (reads from a Zustand store; we feed fake amplitude values that fluctuate)
  - Speaker-color cross-fade (cycles fake user/agent every few seconds)
- [ ] Mobile: `<CallEndedDropped>` component (dropped state UI; not wired to real network yet, accessible via debug toggle)
- [ ] Mobile: Zustand `useCallStore` at app root; call screen mounts against it
- [ ] Mobile: hang-up triggers a fake "ending..." state then returns home

**Demo:** tap phone on home → call screen mounts → orb breathes + responds to fake audio levels + cycles speaker color → tap hang-up → return home.

**Estimated:** 3–4 days. The orb animation alone may eat a chunk of this.

---

## Slice 3 — Real Gemini Live wiring

**Goal:** actual conversation with Muse. Transcripts persist. No ingestion yet.

- [ ] Server: `POST /calls/start` composes minimal system prompt (scaffolding text inline for now — explicit Gemini caching comes Slice 6 when it pays off) + persona + ontology primer + capability stub. Returns `gemini_config` for the client.
- [ ] Mobile: client receives `gemini_config`; opens Gemini Live WebSocket directly to Google
- [ ] Mobile: real audio levels drive the orb (replace fake amplitude); speaker-detection drives orb color
- [ ] Mobile: turn-tagged transcript captured client-side
- [ ] Server: `POST /calls/:session_id/end` accepts transcript JSON; persists `call_transcripts` row; idempotent on `session_id`. NO ingestion enqueue yet — just storage.
- [ ] **Pre-MVP: barge-in working** (already flagged in `todos.md` §8 open). User can interrupt Muse mid-utterance; mic-gate spans full turn; per-buffer onEnded handles cleanup. This is the slice where we tackle it.
- [ ] Server: stub Muse persona prompt — friendly, warm, brief (real persona text drafted in Slice 6)

**Demo:** tap phone → real conversation with Muse → hang up → check `call_transcripts` row in Postgres has the transcript. Orb actually responds to who's talking.

**Estimated:** 5–7 days. Barge-in is the wildcard.

---

## Slice 4 — Ingestion pipeline

**Goal:** transcripts auto-fan-out into wiki content. Validate by SQL queries.

- [ ] Worker: Graphile Worker properly configured (queues, concurrency, recurring scanner job). Per-user `queue_name` for ingestion (`ingestion-${user_id}`).
- [ ] Worker: ingestion job handler — reads transcript by id, runs Flash candidate retrieval (real Gemini call against the locked spec), runs Pro fan-out (real Gemini call against the locked spec), backend transactional commit (sectioned writes + source junctions + wiki_log).
- [ ] Worker: Flash + Pro prompts drafted as actual system prompt strings against the locked decision rules in `specs/flash-retrieval-prompt.md` + `specs/fan-out-prompt.md`. Loaded from prompt files at startup.
- [ ] Server: `POST /calls/:session_id/end` enqueues ingestion job atomically with transcript commit (single transaction).
- [ ] Worker: agent-scope ingestion pass runs in parallel with user-scope (per `specs/agent-scope-ingestion.md`). Single Flash call; observation writes to active agent's subtree.
- [ ] Worker: prompts cached via Gemini explicit cache; cache lifecycle managed by a recurring Graphile job (refreshes TTL every N minutes).

**Demo:** real conversation about Sarah and Consensus → check DB → person page for Sarah created with sections; project page for Consensus created; sources cited in `wiki_section_transcripts`. Agent-scope page has Assistant's observations.

**Estimated:** 7–10 days. This is the heaviest slice; the ingestion pipeline is the central machine.

---

## Slice 5 — RxDB sync + Wiki plugin surface

**Goal:** mobile reactively reflects server-side wiki changes. First "real" plugin overlay UX.

- [ ] Mobile: RxDB setup with Supabase replication plugin; collections defined for MVP-relevant tables (`wiki_pages`, `wiki_sections`, `agents` (sanitized — no `persona_prompt`), `agent_tasks`, `research_outputs`, `tags`, `wiki_page_tags`, `user_settings`, `call_transcripts`, `wiki_log`).
- [ ] Mobile: RxDB hydration — paginated by `updated_at DESC`; recently-touched first
- [ ] Mobile: `<PluginOverlay>` + `usePluginOverlay()` cleanly rebuilt (origin-aware spring; not the sandbox version)
- [ ] Mobile: Wiki plugin tile → overlay screen browsing user's wiki pages from RxDB
  - Virtual folders by `type`
  - Tap a page → page detail with sections rendered as markdown
  - Edit (basic markdown editor — TipTap or similar choice locked at code time)
- [ ] Mobile: realtime updates from server fan-out flow into the UI live (have a call → wiki updates appear in the open Wiki overlay without refresh)

**Demo:** finish a call → tap Wiki tile on home → see the new pages from the call. Edit one in mobile → it persists to Postgres.

**Estimated:** 5–7 days. RxDB + RLS + Supabase replication is the wildcard.

---

## Slice 6 — Onboarding end-to-end

**Goal:** new user signup flows naturally through onboarding into a populated profile.

- [ ] Mobile: `(app)/onboarding.tsx` screen — minimal "Tap to start" launcher
- [ ] Server: `POST /calls/start` accepts `call_type='onboarding'` → composes onboarding scaffolding (separate prompt cache); minimal preload (profile stubs); no recent-activity layer
- [ ] Server: full onboarding system prompt drafted against `specs/onboarding.md` decision rules — opener question, askable/emergent split, capability advertisement discipline, "good enough" heuristic baked in.
- [ ] Mobile: post-Slice-1 routing — first-time user lands on Onboarding screen instead of Home (one-shot redirect after signup completes; subsequent loads go to Home regardless of `onboarding_complete`)
- [ ] Server: end-of-call handler — when `call_type='onboarding'` AND user signaled completion, set `user_settings.onboarding_complete=true`. Subsequent generic calls check the flag at session start; if false, scaffolding nudges "want to pick up?"
- [ ] Mobile: post-onboarding redirect to Home with profile-content visible (via RxDB realtime updates from Slice 5)

**Demo:** new user signs up → lands on onboarding → completes ~10-min interview → profile pages populate live → lands on home.

**Estimated:** 4–6 days. Most of the work is prompt-tuning + the user-experience polish.

---

## Slice 7 — Research plugin end-to-end

**Goal:** first agent_task kind shipped. User can request research and get a result.

- [ ] Worker: plugin registry module (`pluginRegistry` server-only + `pluginRegistryLite` derived for client) with `research` entry per `specs/research-task-prompt.md`
- [ ] Worker: research handler implementing the `(ctx) => Promise<{output, sources, reingestIntoWiki}>` contract
- [ ] Worker: research prompt text drafted from the locked spec
- [ ] Worker: `agent_tasks` queue setup (separate from `ingestion-${user_id}` queue); CRON scanner for delayed/retry pickup
- [ ] Worker: `research_outputs` write helper + per-kind source junction writes (`research_output_sources`, `research_output_ancestors`)
- [ ] Worker: usage_events emission per LLM call
- [ ] Server: ingestion's commitment-extraction creates agent_tasks rows when Pro detects research-intent commitments (already part of `specs/fan-out-prompt.md` §4.1)
- [ ] Mobile: Research plugin tile → overlay screen showing list of `research_outputs` for this user (synced via RxDB)
- [ ] Mobile: research detail view — query, summary, findings, citations
- [ ] Mobile: spawn-research affordance from the Research overlay (calls a server endpoint that creates an agent_tasks row directly, bypassing ingestion — for explicit user requests outside of a call)

**Demo:** in a call, "can you research Italian restaurants near me?" → after call, research arrives in Research module 1–3 minutes later → tap to read.

**Estimated:** 6–8 days. Most work is prompt drafting + handler implementation + the spawn-from-call orchestration.

---

## Slice 8 — Todos + Profile plugin surfaces

**Goal:** all 4 MVP plugin tiles functional.

- [ ] Mobile: Todos plugin overlay
  - Projection over `wiki_pages WHERE type='todo'` joined with `agent_tasks`
  - Status tabs (todo / in-progress / done / archived)
  - Check-off → reparent to `done` bucket (write to `wiki_pages.parent_page_id`)
  - Show agent-task status for agent-assigned todos (running / succeeded / failed)
  - Sub-tasks via hierarchy
  - Manual create-todo affordance
- [ ] Mobile: Profile plugin overlay
  - Browse profile root + 9 children
  - Render section content as markdown
  - Edit affordance on user-scope pages
- [ ] Mobile: greeting subtext updated to reflect actual user activity if appropriate (or omitted, per design decision)

**Demo:** finish a call with commitments → see todos appear in Todos overlay → check one off, persists. View profile pages and edit.

**Estimated:** 4–6 days. Todos UX has surprising complexity (status transitions, agent-task display); Profile is simpler.

---

## Slice 9 — Pre-launch hardening

**Goal:** the thing is shippable.

- [ ] Server + worker: real RLS policies per `todos.md` §3 RLS draft
- [ ] Server: cross-agent leakage tests passing (per `todos.md` §3)
- [ ] Server: rate limiting per user (call starts, task triggers, signup attempts)
- [ ] Server: account-deletion flow (basic — tombstone user_id; full hard-delete + export V1+)
- [ ] Sentry integration validated (real errors firing on both client and server)
- [ ] PostHog feature flags wired (at minimum, a kill-switch flag for ingestion + a kill-switch for research-task spawning)
- [ ] EAS Build configured; first TestFlight build pushed
- [ ] Render deploys for `apps/server` + `apps/worker` working from CI; staging environment alive
- [ ] CI pipeline (GitHub Actions): typecheck + lint + test + DB-migration check
- [ ] Cost monitoring — ad-hoc SQL queries against `usage_events` confirm per-user spend looks reasonable
- [ ] PII redaction at pino transport layer validated (sample logs reviewed; no obvious leaks)

**Demo:** install via TestFlight → end-to-end onboarding → first call → research arrives → wiki populates over multiple calls → tier-cap interactions present and accounted for. Ready for closed-beta users.

**Estimated:** 7–10 days. Mostly operational + hardening; no new product surface area.

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
