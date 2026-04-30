# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Audri — voice-first personal knowledge OS. The user talks with an agent ("Audri") via Gemini Live; transcripts feed an ingestion pipeline that maintains a per-user wiki (knowledge graph). Background agent tasks (research first, more plugins V1+) operate against that graph.

MVP shipped as v0.1.0 to TestFlight on 2026-04-29.

## Repo layout

pnpm workspace, three runtime apps + one shared package:

- `apps/mobile` — Expo / React Native client (`@audri/mobile`). Expo Router file-based routing under `app/`, RxDB-wrapped SQLite mirror with Supabase replication under `lib/rxdb/`, Gemini Live session under `lib/gemini/`, NativeWind styling.
- `apps/server` — NestJS API (`@audri/server`) on Render. Modules: `calls`, `me`, `todos`, `tasks`, `webhooks`, `seed`, `health`, plus `auth/` (Supabase JWT guard) and `throttler/` (per-user rate limit).
- `apps/worker` — Graphile Worker runner (`@audri/worker`) on a separate Render service. Tasks: `ingestion` (per-user FIFO queue), `agent_task_dispatch`, `heartbeat`. Ingestion pipeline lives under `ingestion/`; plugin handlers under `research/` + `registry/`.
- `packages/shared` — `@audri/shared`. Drizzle schema (`src/db/schema/`), Postgres client, Gemini wrapper, PostHog wrapper. Exports subpath modules (`@audri/shared/db`, `/db/schema`, `/gemini`, `/posthog`). Built to `dist/` — **server and worker import the compiled output, so `@audri/shared` must be built before typechecking them.**
- `.claude/architecture/` — authoritative design docs (see "Architecture docs" below). Always read these before redesigning anything; don't duplicate their content into code comments.
- `sandbox/` — scratch space, ignored by Biome.

## Common commands

Run from repo root unless noted.

```bash
# Quality gates (CI runs all of these)
pnpm --filter @audri/shared build  # required before typecheck — server/worker import dist/
pnpm typecheck                     # tsc --noEmit across all workspaces
pnpm lint                          # biome lint
pnpm check                         # biome lint + format check
pnpm format                        # biome format --write

# Server / worker dev (both load ../../.env.local via tsx --env-file)
pnpm dev:server                    # NestJS on :8080 with watch
pnpm dev:worker                    # Graphile worker with watch

# Drizzle (run from repo root; delegates to apps/server)
pnpm db:generate                   # generate migration from schema diff
pnpm db:migrate                    # apply migrations against DATABASE_URL
pnpm db:push                       # push schema directly (dev only)
pnpm db:studio                     # open drizzle-kit studio

# Mobile (work inside apps/mobile or use --filter)
pnpm --filter @audri/mobile start          # expo start
pnpm --filter @audri/mobile ios            # native iOS build + run
pnpm --filter @audri/mobile typecheck

# EAS builds — manual only, monthly quota gates this. Don't wire to CI.
pnpm testflight                    # preview profile + auto-submit
pnpm build:ios:preview
pnpm build:ios:production
pnpm submit:ios
```

There is no test runner installed yet. `apps/server/src/__tests__/rls-leakage.test.ts` is a vitest-shaped scaffold that's documented but not runnable — see the file header for the wire-up plan.

## Architecture essentials

These are the load-bearing facts that aren't obvious from a single file. For the full system design read `.claude/architecture/architecture.md` first.

### Schema is owned by `@audri/shared`, migrations live in `apps/server`

`packages/shared/src/db/schema/` is the single Drizzle source of truth. `apps/server/drizzle.config.ts` reads it via relative path (`../../packages/shared/src/db/schema/index.ts`); migrations are generated into `apps/server/drizzle/` and applied by `apps/server/src/db/migrate.ts`. Mobile, server, and worker all type against the same schema by importing from `@audri/shared/db/schema`.

### Two Postgres connection strings

Supabase direct DB is IPv6-only; Render's starter plan has no IPv6. Use:
- **Pooled connection string** for runtime (`DATABASE_URL` on the Render web + worker services).
- **Direct connection string** for migrations from a developer machine.

Both go through `@audri/shared/db/client`. Do not invent a third client.

### Voice + ingestion data flow

`POST /calls/start` composes a 7-layer system prompt and returns Gemini Live config. The mobile client opens the WebSocket directly to Google. Tool calls (`search_wiki`, `fetch_page`) route back through the API. On end, `POST /calls/:session_id/end` commits the transcript and atomically enqueues an `ingestion` job onto the **`ingestion-${user_id}`** Graphile queue (per-user FIFO; different users run in parallel). The ingestion task does Phase 1 retrieval (Flash) → Phase 2 fan-out (Pro) → Phase 3 transactional commit, plus a parallel agent-scope ingestion pass. See `specs/flash-retrieval-prompt.md`, `specs/fan-out-prompt.md`, `specs/agent-scope-ingestion.md`.

### Plugin registry is the universal trigger

Every agent-executed action is mediated by an `agent_tasks` row whose `kind` keys into the registry in `apps/worker/src/registry/plugin-registry.ts`. Each entry carries prompt, handler, schemas, capability description, model tier, token budget, retry policy, etc. MVP has one plugin: `research`. Adding a new capability = (1) registry entry, (2) prompt, (3) handler, (4) artifact table + migration, (5) UI module, (6) capability description so the call-agent can advertise it. **No changes to ingestion, dispatcher, or activity stream are needed.**

### Wiki structure

`wiki_pages` (typed: `person, concept, project, place, org, source, event, note, profile, todo`, plus agent-scope `agent`) → `wiki_sections` (h2-granularity; the unit the fan-out prompt writes at) → per-source-kind junction tables (`wiki_section_transcripts`, `_urls`, `_ancestors`). **Wiki = distilled knowledge; artifacts (e.g. `research_outputs`) live in their own per-kind tables, not in the wiki.**

`scope='user'` is fully visible/editable; `scope='agent'` is each persona's private notes about the user — readable, not directly editable, partitioned per-agent via RLS. Persona prompt fields (`persona_prompt`, `user_prompt_notes`) are server-only — never returned by client-facing endpoints, never synced to RxDB.

### Mobile state at the app root

The active call session is held at the app root (Zustand store in `lib/useCallStore.ts`) so navigating away doesn't tear it down. RxDB initialization is also app-root scoped (`lib/rxdb/`); UI components consume it through the typed hooks (`useWikiPages`, `useAgentTasks`, `useResearchOutputs`).

## Conventions and constraints

- **Biome** is the formatter + linter. Config bans non-null assertions (warn), enforces `useImportType` / `useExportType`, and sorts Tailwind classes via `clsx`/`cva`/`cn`/`twMerge`. Single quotes, semicolons, trailing commas.
- **TypeScript** strict + `noUncheckedIndexedAccess`. Server and worker are ESM (`"type": "module"`); imports must use explicit `.js` extensions even when importing `.ts` source.
- **NestJS DI:** when adding a provider that gets injected into another module, declare it with `@Inject()` + a string token where esbuild's class-name mangling could break the type-based resolution. (Burned by this in the auth slice — see `project_oauth_setup_pitfalls` memory.)
- **NativeWind v5 preview** — `lightningcss` is pinned to `1.30.1` via root pnpm overrides. Don't bump it without checking NativeWind compatibility.
- **Expo env vars** — only `.env.local` in `apps/mobile/` is read by the Expo CLI; the monorepo root `.env.local` is read by server + worker via `tsx --env-file`. They are separate files.
- **PostHog** has a kill-switch on major AI inference flows; check existing usage in `@audri/shared/posthog` before adding new tracking on the inference path.
- **EAS builds are manual.** Monthly quota — do not propose CI-triggered EAS builds.

## Architecture docs

Always look here before designing anything new. They are the source of truth; this file is a pointer.

- `architecture.md` — system overview (data flow, scopes, ingestion stages, schema sketch).
- `features.md` — feature catalog at the target horizon.
- `tradeoffs.md` — decisions where alternatives were weighed.
- `judgement-calls.md` — autonomous decisions made without explicit user confirmation.
- `backlog.md` — V1+ deferred work. **New feature requests post-MVP default here**, not into a build phase.
- `build-phases/<semver>.md` — what's actively being built for a given release.
- `specs/` — per-area specs: `mobile-app.md`, `db-schema-plan.md`, `onboarding.md`, `agents-and-scope.md`, `agent-scope-ingestion.md`, `flash-retrieval-prompt.md`, `fan-out-prompt.md`, `research-task-prompt.md`.
- `notes/` — design notes (data-flow architecture, ingestion-pipeline breakdown, etc.).
