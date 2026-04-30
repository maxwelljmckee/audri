# Audri — Pre-Build TODOs & Open Questions

A complete checklist of decisions, questions, and tasks that gate the start of production backend (and supporting client) work. Organized by area. Some items are already settled — marked ✅ — and kept here for traceability so the final spec documents can reference the full decision history.

**Legend**

- ✅ — decided / done
- ✴️ — partially decided; needs refinement
- ⏺️ — open; needs a decision
- ⛔ — blocked on another decision (dependency noted inline)

Items flagged **SPEC** are substantial enough to deserve their own dedicated design doc under `.claude/architecture/specs/` before implementation.

---

## 1. Product vision & principles

- ✅ **Product vision**
  - Voice-first, KG-backed personal assistant ("Audri"). (architecture.md §Vision)
- ✅ **Target capability list**
  - Onboarding, calls, research, podcasts, briefs, calendar, email, scheduled tasks, graph view. (architecture.md §Target capabilities)
- ✅ **Core UX principles**
  - Proactiveness, Transparency, friction proportional to reversal cost. (architecture.md §Core UX principles)
- ✅ **Interaction modes framing**
  - Call (priority), Ask (deferred), Note (deferred).
- ✅ **Feature horizon catalog**
  - Call experience, activity stream, navigation, content delivery, scheduled content, knowledge ingestion. (features.md)
- ✅ **MVP feature cut**
  - **V0 (MVP):** Call mode, transcript ingest + fan-out, wiki browse/edit, background research, onboarding interview, in-app notifications (for research completion).
  - **V1 (next after MVP):** Podcasts (requires Supabase Storage setup), scheduled/recurring tasks, proactive recommendations, activity-stream UI polish, push notifications.
  - **Deferred further:** Email drafting, calendar event creation, daily/evening briefs, contacts import, Ask/Note modes, graph view, event-driven content (RSS/topic monitoring), knowledge ingestion uploads, plugin launcher.

---

## 2. Tech stack

### Client

- ✅ **Framework**
  - React Native + Expo.
- ✅ **Conversational agent**
  - Gemini Live.
- ✅ **Audio**
  - React Native Audio API for mic streaming, playback, processing.
- ✅ **Local wiki mirror**
  - Client maintains a SQLite-backed mirror of the wiki, wrapped by RxDB.
- ✅ **Client-side DB + sync**
  - **RxDB** with the **Supabase replication plugin**, backed by an SQLite storage adapter (via `expo-sqlite` or equivalent). RxDB gives us observable queries (UI auto-updates when fan-out completes) and a turnkey bidirectional sync protocol with built-in conflict resolution — subsumes the custom sync layer we would otherwise build on raw SQLite.
- ✅ **State management**
  - **Zustand.** Lightweight, hooks-native, no Redux boilerplate.
- ✅ **Navigation**
  - **Expo Router** (file-based routing).

### Server

- ✅ **Framework**
  - NestJS.
- ✅ **Data / auth / realtime / storage**
  - Supabase (Postgres + Auth + Realtime + Storage).
- ✅ **Agentic workflows**
  - **Gemini SDK (`@google/genai`) directly — no Langchain.** Langchain's abstractions are a poor fit for our bespoke pipelines (fan-out, preload, call-agent tool use). We build the small amount of orchestration we need ourselves.
- ✅ **Inference provider strategy**
  - **Gemini-only for MVP.** Cost-optimized — Gemini is ~2–3× cheaper than Anthropic tier-for-tier, and Gemini's explicit caching (guaranteed cost savings, cache-object API) matches Anthropic's prompt caching for our main use cases. Single vendor is also operationally simpler given we're already on Gemini Live for calls. The inference layer is abstracted lightly (one internal interface) so a specific pipeline can route to Anthropic if a prompt refuses to stabilize, but we start Gemini-only.
- ✅ **Model tiering**
  - **Flash** (2.5 or 3 Preview): candidate retrieval (stage 1 of fan-out), lightweight classifiers. Abstract regeneration is currently inlined with Pro's fan-out writes rather than a separate Flash pass — see §17 refactor path if this becomes a cost driver.
  - **Pro** (2.5 or 3 Preview): fan-out main call (stages 2–7), research agent.
  - **Gemini Live**: in-call conversational agent (already in use).
- ✅ **Prompt caching strategy (provider-specific)**
  - **Explicit caching** for the fan-out main prompt (static KG parsing system instruction, 5–10k tokens, same across users — one cache per model version, long TTL). Also for call-agent scaffolding and research-task scaffolding.
  - **Implicit caching** handles everything else; helped by putting large common content at the start of the prompt.
  - **Cache lifecycle** is owned by a dedicated LLM-inference service module in NestJS (create, TTL refresh, cleanup on model-version bumps) so it doesn't leak into every call site.
  - Mind the minimum-token thresholds for explicit caching (1024 on Flash, 4096 on Pro for 2.5). Smaller prompts rely on implicit caching.
- ✅ **Background job queue**
  - **Graphile Worker** (Postgres-backed, runs inside NestJS — no Redis, single datastore to operate). Supports cron, retries, priorities, job types. Migrate to BullMQ or Inngest if throughput or durable-execution patterns demand it.
- ✅ **Deployment target**
  - **Render** for NestJS. Simple DX, plays well with Supabase, cheap at MVP scale.
- ✅ **Storage bucket layout** (deferred)
  - Deferred to V1. MVP has no user-visible storage usage — transcripts live in `call_transcripts.content` in Postgres. Podcasts in V1 will force the bucket-layout design.
- ✅ **Realtime channels plan**
  - **No custom channel strategy.** Realtime is consumed via the RxDB Supabase plugin (pull-side incremental updates); app code never touches Realtime APIs directly.

### Dev tooling

- ✅ **Monorepo tooling**
  - **pnpm workspaces.** Zero config. Add Turborepo only if build times demand it.
- ✅ **TypeScript config sharing**
  - Base `tsconfig.json` + per-package extends. Standard pnpm workspace pattern.
- ✅ **Shared types package**
  - `packages/shared` — DB row types (generated from Drizzle schema) + API contract types shared across client and server.
- ✅ **Server ORM + migrations**
  - **Drizzle ORM** on the server for Postgres access and schema-first migrations. Generates the row types consumed by `packages/shared`.
- ✅ **Linter / formatter**
  - **Biome.** Single tool, faster than ESLint + Prettier.
- ✅ **Local dev environment**
  - **Supabase CLI** for local Postgres + Realtime. NestJS runs via `pnpm dev`.
- ✅ **Mobile build + store submission**
  - **EAS (Expo Application Services)** — EAS Build for iOS/Android builds, EAS Submit for store submission, EAS Update for OTA updates. Free tier sufficient for MVP; migrate to Fastlane + GitHub Actions if cost becomes material.
- ✅ **Error reporting**
  - **Sentry** on client and server.
- ✅ **Analytics + feature flags**
  - **PostHog** — product analytics + feature flags in one. Generous free tier.

---

## 3. Data model

### Core tables

- ✅ **`wiki_pages` draft**
  - id, user_id, scope, type, slug, parent_page_id, title, agent_abstract, abstract, frontmatter, timestamps, tombstoned_at, **agent_id (nullable, required when scope='agent', enforced by CHECK constraint)**.
  - `agent_abstract` (required): terse machine-consumed abstract, ~1 sentence. Surfaced in the wiki index, preloaded slices, cross-reference resolution. First-class LLM prompt input.
  - `abstract` (nullable): human-readable opening paragraph, rendered between title and first section. More wiggle room than `agent_abstract` but still brief.
  - `agent_id` denormalizes per-agent ownership of agent-scope pages so preload + ingestion can filter in one indexed read (vs. walking `parent_page_id` up to the agent root). See `specs/agents-and-scope.md`.
  - `content` is NOT on `wiki_pages` — page body lives in `wiki_sections` (see below).
- ✅ **`agents` table** (new)
  - id, user_id, slug, name, voice, persona_prompt, user_prompt_notes (nullable), root_page_id (FK → wiki_pages), is_default, created_at, tombstoned_at.
  - Exactly one row per user at MVP (seeded `Assistant` with `is_default=true`); table is multi-agent-ready from day one.
  - See `specs/agents-and-scope.md`.
- ✅ **`agent_tasks` table** (new — companion to todo wiki pages for agent-assigned actions)
  - Shape (locked): id, user_id, todo_page_id (FK → wiki_pages), agent_id (FK → agents, nullable — task run on user's behalf by a specific persona), kind (enum: research, podcast, email_draft, calendar_event, brief, …), payload (jsonb — validated per-kind via zod schema declared in the plugin registry), status (pending, running, succeeded, failed, cancelled), priority, scheduled_for, started_at, completed_at, retry_count, last_error, graphile_job_id (text, for correlation with the current Graphile Worker job), result_artifact_kind (text, nullable — which artifact table holds the result), result_artifact_id (uuid, nullable — FK resolved at read-time per `result_artifact_kind`).
  - `is_trial: bool` column deferred to V1+ alongside trial-artifacts feature.
  - `max_attempts` is not a column — retry ceiling comes from the registry entry for the task's `kind`. Per-row override deliberately skipped as YAGNI.
  - No `input_snapshot` — tasks operate on current KG state at run time. If the user edits mid-flight and output looks stale, re-run. Revisit if this bites.
  - No denormalized cost/token fields — canonical record is `usage_events` (§17b); join when displaying.
  - `result_artifact_*` fields replace the earlier `result_artifact_page_id (FK → wiki_pages)` field now that artifacts live in per-kind tables (see below), not in `wiki_pages`.
  - Rationale: wiki page is the user-facing / graph-citizenship representation of a todo; `agent_tasks` is the workflow substrate the queue actually scans. User-assigned todos ("buy milk") have only the wiki page; agent-assigned todos have both, linked by FK.
  - Graphile Worker is the runtime queue on queue `agent_tasks`; `agent_tasks` rows are our durable domain records, enqueued as Graphile jobs by the CRON scanner. See §11.
- ✅ **`wiki_sections` draft**
  - id (uuid, no slug), page_id, title (nullable), content (markdown), sort_order, timestamps, tombstoned_at.
  - Sections are the unit of editable content — h2-granularity. h3+ stays inside section markdown.
  - Pro emits targeted section edits (keep/update/create/tombstone) rather than full-page rewrites. Dramatically reduces token cost on updates as pages grow.
  - Pro always *reads* the fully-joined page so it retains contextual understanding; it only *writes* at the section level.
  - `UNIQUE (page_id, title) WHERE title IS NOT NULL` — no duplicate titled sections on a page.
  - Timeline is represented as a section with `title = 'Timeline'`, conventionally pinned first by prompt rule. See §4 Mutability.
- ✅ **`wiki_section_history`**
  - Full-snapshot history at the section level with `edited_by`. Per-version `content` snapshot on edit.
  - Page-level creation/tombstone events tracked in `wiki_log` rather than a dedicated `wiki_page_history` table.
  - Reconstruction of "page as of time T" = join across sections, filter to latest-version-before-T per section.
- ✅ **`tags` + `wiki_page_tags`**
  - User-defined tags and a join table against pages. Covers cross-cutting groupings now that `topics` is dropped.
- ✅ **`call_transcripts`**
  - Immutable transcript storage.
  - **`tool_calls` jsonb column (nullable)** — captures per-turn tool invocations and their results (search_wiki, fetch_page, web grounding citations). Used at ingestion time to attribute claims to URLs (`wiki_section_urls`) when Audri referenced a web result during the call. See §8 Chunk 4.
- ✅ **Per-entity source junction tables** (section-level, replacing the earlier page-level + polymorphic designs)
  - `wiki_section_transcripts(section_id, transcript_id, turn_id, snippet, cited_at)` — transcript-sourced writes (primary MVP path).
  - `wiki_section_urls(section_id, url, snippet, cited_at)` — URL-sourced writes with per-passage snippets.
  - `wiki_section_ancestors(section_id, ancestor_page_id, snippet, cited_at)` — for derived sections that drew from existing wiki pages. Cited unit is a page (coarse ancestor granularity).
  - `wiki_section_uploads(section_id, upload_id, snippet, cited_at)` — V1, added when Supabase Storage + uploads land.
  - **Per-artifact-kind junctions (V1+)** — one table per artifact kind that re-ingests into the wiki. No MVP junctions — all kinds default `reingestsIntoWiki: false` at MVP so no junction is exercised. V1+: `wiki_section_research`, `wiki_section_briefs` added when/if those kinds opt into re-ingestion. Podcast/email/calendar artifacts never re-ingest (consumption formats / external-API writes) — no junction ever needed.
  - Gains: FK referential integrity, trivial JOINs, type-specific fields per source/artifact kind, precise citation granularity (section not page). User edits don't need a source row — `wiki_section_history.edited_by='user'` IS the provenance.
- ✅ **Artifact tables** (new — per-plugin tables, not `wiki_pages`)
  - Artifacts (research outputs, podcasts, email drafts, calendar events, briefs) live in dedicated per-kind tables with bespoke schemas, **not** as `wiki_pages`. Wiki is for distilled knowledge (user-authored or conversation-fanned-out); Artifacts are AI-produced outputs with their own structure.
  - Text artifacts (research, briefs) *may eventually* re-ingest into the wiki as a follow-on step — the artifact becomes a source that fans out findings into `person` / `concept` / etc. wiki pages. **At MVP, no kind re-ingests** — each plugin's UI module surfaces its own artifacts; findings live in the artifact table only. Re-ingestion is a V1+ capability controlled per-kind by `registry[kind].reingestsIntoWiki`.
  - Binary artifacts (podcast audio) live in Supabase Storage; the artifact table holds the storage ref + metadata only.
  - Each kind's table shape is bespoke; draft shapes live under the kind-specific entries below (§3 podcast / email / calendar / brief).
- ✅ **`wiki_log`**
  - Append-only chronological activity log. Also records page-level creation/tombstone events (since we dropped `wiki_page_history`).

### Open table-level questions

- ✅ **Full data model review pass**
  - All decisions consolidated. Final tables for MVP migration: `auth.users` (Supabase), `agents`, `wiki_pages`, `wiki_sections`, `wiki_section_history`, `wiki_section_transcripts`, `wiki_section_urls`, `wiki_section_ancestors`, `wiki_log`, `tags`, `wiki_page_tags`, `call_transcripts`, `agent_tasks`, `research_outputs`, `research_output_sources`, `research_output_ancestors`, `usage_events`, `user_settings`. V1+ adds: `wiki_section_uploads`, `wiki_section_research` (when re-ingestion enabled), `connectors`, `notifications`, `recommendations`, `schedules`, `uploads`, `proposed_action_items`, `agents.is_trial` (column add), per-V1-plugin artifact tables (`podcasts`, `email_drafts`, `calendar_events`, `briefs`).
  - Drizzle schema generation + migrations drafted as part of MVP code work; not a SPEC concern.
- ✅ **Indexes — explicit plan**
  - `wiki_pages`: `(user_id, scope, type)` for type-filtered browse; `(user_id, scope, slug) UNIQUE` for slug resolution; `(user_id, scope, agent_id, parent_page_id)` for hierarchy descents under an agent's subtree; `(parent_page_id) WHERE tombstoned_at IS NULL` for sibling lookups; GIN on `frontmatter` for tag/alias filtering.
  - `wiki_sections`: `(page_id, sort_order)` for render-order; GIN tsvector on `content` for FTS; `(page_id, title) WHERE title IS NOT NULL UNIQUE` (already noted in §3 core tables).
  - `wiki_section_history`: `(section_id, created_at DESC)` for "page as of T" reconstruction.
  - `wiki_section_transcripts`: `(transcript_id)` for reverse-lookup (transcript → sections); `(section_id)` for forward-lookup.
  - `wiki_section_urls`: `(url)` for grouping cited sources; `(section_id)`.
  - `wiki_section_ancestors`: `(ancestor_page_id)` for reverse-lookup; `(section_id)`.
  - `wiki_log`: `(user_id, created_at DESC)` for activity-stream + recent-activity preload.
  - `agent_tasks`: `(user_id, status, scheduled_for)` for CRON scanner + queue depth queries; `(graphile_job_id)` for correlation; `(todo_page_id)` for FK lookups.
  - `call_transcripts`: `(user_id, started_at DESC)` for call-history; `(session_id) UNIQUE` for idempotency.
  - `usage_events`: `(user_id, created_at DESC)` per-user rollup; `(user_id, event_kind, created_at DESC)` per-service attribution; `(agent_tasks_id)` per-task cost join.
  - `agents`: `(user_id, slug) UNIQUE`; `(user_id, is_default)`.
  - `research_outputs`: `(user_id, generated_at DESC)`; `(agent_tasks_id)` for FK.
- ✅ **Polymorphic artifact-source table**
  - **Resolved: per-entity junction tables, not a polymorphic table.** See core tables above. Gains referential integrity and type-specific fields; loses nothing meaningful (cross-type source listings are a UNION or a VIEW, cheap).
- ✅ **Artifacts-as-separate-tables (pattern locked)**
  - Each artifact kind gets a dedicated table (+ Supabase Storage bucket for binaries); artifacts are NOT `wiki_pages`. Text artifacts may re-ingest into the wiki via the ingestion pipeline with the artifact as source. See §3 core tables > Artifact tables for the full rationale.
- ✅ **Research-output artifact shape** (MVP — only task kind in V0)
  - Dedicated `research_outputs` table. Proposed shape: id, user_id, agent_tasks_id (FK — the task that produced it), query (text), findings (jsonb — structured per output-schema), generated_at, model_used, tokens_in, tokens_out, tombstoned_at. Provenance: `research_output_sources(research_output_id, url, snippet, cited_at)` for external URLs cited; `research_output_ancestors(research_output_id, ancestor_page_id, snippet, cited_at)` for wiki pages drawn from. **No re-ingestion into wiki at MVP** — findings live in the Research UI module; explicit flow-to-wiki is V1+. Immutable post-creation (UI offers no edit).
- ⏺️ **Podcast-output table** (V1) — **SPEC**
  - Proposed shape: id, user_id, agent_tasks_id (FK), script (text), audio_ref (text — Supabase Storage path), duration_s (int), chapters (jsonb), speakers (jsonb), generated_at, tombstoned_at. Provenance: `podcast_sources` (per-kind junction — cited research outputs, wiki pages, URLs as needed). No re-ingestion — podcasts are consumption formats. Immutable.
- ⏺️ **Brief (daily/weekly) artifact table** (V1) — **SPEC**
  - Proposed shape: id, user_id, agent_tasks_id (FK), kind ('daily' | 'weekly' | 'evening' | custom), content (markdown), generated_at, period_start, period_end, tombstoned_at. May re-ingest salient items into the wiki (e.g., "today's reflections" fan out into relevant pages). Likely immutable though worth revisiting — briefs may benefit from user annotations.
- ⏺️ **Email-draft table** (V1) — **SPEC**
  - Proposed shape: id, user_id, agent_tasks_id (FK), recipient (text), subject (text), body (markdown), connector_id (FK → connectors — which email account to send from), status ('draft' | 'sent' | 'cancelled'), sent_at (nullable), provider_message_id (nullable — populated after send), generated_at, tombstoned_at. No re-ingestion by default; if user sends the email, the sent fact is a noteworthy event that could flow through a separate path. Drafts are editable until sent.
- ⏺️ **Calendar-event table** (V1) — **SPEC**
  - Proposed shape: id, user_id, agent_tasks_id (FK), connector_id (FK → connectors), title (text), start_at, end_at, description (text), attendees (jsonb), status ('proposed' | 'confirmed' | 'cancelled'), provider_event_id (nullable — populated after create), generated_at, tombstoned_at. No re-ingestion.
- ⏺️ **Notification table**
  - id, user_id, kind, artifact_ref, body, read/unread, snoozed_until. Depends on §13 notifications design.
- ⏺️ **Recommendation table**
  - Reuse notifications, or own table. Kinds: schedule-proposal, split-proposal, follow-up, merge-proposal. Fields: payload, status (pending/accepted/dismissed/snoozed).
- ⏺️ **Schedule / recurring-task table**
  - Cron spec, task kind, params, delivery preferences, pause state, next-run, owner.
- ⏺️ **Upload / ingested-source table**
  - Raw file ref, mime type, provenance, processing status.
- ⏺️ **Proposed action-item table**
  - User-confirmed vs. pending-confirmation rows emitted from call-end flow, linked to the transcript that produced them.

### History & retention

- ✅ **History retention policy**
  - **MVP: full snapshots, indefinite retention.** No GC, no diff compression. Storage growth is a non-issue at MVP user count. Revisit at first sign of cost pressure (per-user `wiki_section_history` row count > some threshold) — flagged in `backlog.md` for V1+ as "History retention compaction."
- ✅ **Tombstone retention**
  - **MVP: permanent.** Tombstoned rows stay forever; `tombstoned_at` timestamp is the marker. Lets users undo even months-old tombstones. GC policy V1+ if storage grows visibly.

### Frontmatter

- ✅ **Frontmatter convention draft**
  - type, title, aliases, tags, sources, timestamps.
- ✅ **Frontmatter review**
  - **Columns** (queried frequently, structured): `id`, `user_id`, `scope`, `type`, `slug`, `parent_page_id`, `title`, `agent_abstract`, `abstract`, `agent_id`, `created_at`, `updated_at`, `tombstoned_at`.
  - **`frontmatter` jsonb** (loosely-structured, type-specific): `aliases: string[]`, `tags: string[]` (denormalized echo of `wiki_page_tags` for fast inline render), per-type fields like `assignee/priority/due_at` for `todo`, `event_date` for `event`, etc. UI edit screens read/write the jsonb directly.
- ✅ **Alias indexing strategy**
  - **MVP: GIN index on `frontmatter` jsonb covers `aliases` array lookups.** No separate `aliases` table at MVP. If voice-disambiguation latency becomes a hot path, add a trigram index on a generated column or extract to `aliases(page_id, alias)` table — flagged in `backlog.md`.

### RLS

- ✅ **RLS principle**
  - Agent-scope pages server-only; user-scope rows user-id filtered.
- ✅ **RLS policy set — MVP draft**
  - **`wiki_pages`**: `SELECT/UPDATE/DELETE WHERE user_id = auth.uid() AND scope = 'user'` for client (RxDB sync); server role bypasses for agent-scope reads/writes. INSERT only via server (no client-side page creation outside the standard write paths).
  - **`wiki_sections`**: `SELECT/UPDATE WHERE page_id IN (SELECT id FROM wiki_pages WHERE user_id = auth.uid() AND scope = 'user')` for client; server role bypasses.
  - **`wiki_section_history`, `wiki_section_transcripts`, `wiki_section_urls`, `wiki_section_ancestors`**: `SELECT WHERE section_id IN (...)` for client (read-only); INSERT only via server.
  - **`agents`**: `SELECT WHERE user_id = auth.uid()` for client (display metadata only — `persona_prompt` NEVER returned via API per `specs/agents-and-scope.md` Invariant 3); INSERT/UPDATE/DELETE server-only.
  - **`call_transcripts`**: `SELECT WHERE user_id = auth.uid()` for client (call history); INSERT/UPDATE server-only.
  - **`agent_tasks`**: `SELECT WHERE user_id = auth.uid()` for client (status display); INSERT/UPDATE server-only.
  - **`research_outputs`**, **`research_output_sources`**, **`research_output_ancestors`**: `SELECT WHERE user_id = auth.uid()` (or via FK) for client; INSERT server-only.
  - **`wiki_log`**: `SELECT WHERE user_id = auth.uid()` for client (activity stream); INSERT server-only.
  - **`tags`**, **`wiki_page_tags`**: `SELECT/INSERT/UPDATE/DELETE WHERE user_id = auth.uid()` for client (user can manage tags from UI).
  - **`usage_events`**: `SELECT WHERE user_id = auth.uid()` for client (cost-visibility V1+); INSERT server-only.
  - **`user_settings`**: `SELECT/UPDATE WHERE user_id = auth.uid()` for client.
  - Persona prompt redaction: `agents` SELECT policy excludes `persona_prompt` + `user_prompt_notes` columns from the client-facing view (use a separate Postgres view with restricted columns, or column-level grants). RxDB only syncs the safe columns.
- ✅ **Agent-scope leak-prevention tests**
  - Test cases (per `specs/agents-and-scope.md` Privacy invariants):
    1. Client `SELECT * FROM wiki_pages WHERE scope='agent'` → empty result.
    2. Client `SELECT * FROM wiki_pages WHERE agent_id='<other_user_agent_id>'` → empty.
    3. Client `SELECT * FROM agents WHERE user_id != auth.uid()` → empty.
    4. Client SELECT on `agents` → no `persona_prompt` / `user_prompt_notes` columns visible.
    5. Cross-agent: with active session for agent A, attempt to read agent B's wiki via direct slug → empty.
    6. INSERT/UPDATE attempts to fabricate `scope='agent'` from client → rejected.
    7. RLS policies still active when run as authenticated user (not service role).
  - Implemented as integration tests against a real Postgres + Supabase Auth — no DB mocks (per `tradeoffs.md` integration test posture).

### Sync model

- ✅ **Source-of-truth model**
  - Server is source of truth; client is a mirror hydrated via Supabase Realtime + RxDB Supabase replication plugin.
- ✅ **Conflict resolution policy**
  - **MVP: server-wins for AI writes; last-write-wins (LWW) for user edits.** When user edits a section that's also being updated by post-call ingestion, the server resolves: if the AI write committed before the user's edit reaches the server, user edit wins (overwrites AI version). If user's edit committed before AI ingestion runs, ingestion's section update overwrites the user edit. RxDB's standard LWW conflict handler covers this; no custom merge logic. Per-section history (`wiki_section_history`) preserves both versions for audit.
  - **Edge case to revisit:** if users frequently see their edits clobbered by ingestion, add a "user-edit lock" — `wiki_sections.user_edited_at` timestamp; ingestion skips sections edited within last N minutes. Flagged in `backlog.md` as a P2 refinement.
- ✅ **Offline behavior**
  - **MVP: optimistic offline reads + queued offline writes.** RxDB caches locally; reads work disconnected. Writes queue locally and replay on reconnect via the Supabase replication plugin's standard mechanism. Conflicts on replay resolved via the LWW policy above. Calls (Gemini Live) require connectivity — no offline call-mode.
- ✅ **Initial hydration strategy**
  - **MVP: paginated backfill + realtime.** First login: client requests user's wiki pages in pages of ~100, ordered by `updated_at DESC` (recently-touched first → user sees recent stuff fast). RxDB Supabase replication plugin handles the streaming. Subsequent: realtime sync only.
  - For large wikis (V1+ scale), incremental backfill with priority (profile + recently-touched first, rest stream in background) is a refinement — flag if hydration time hurts first-load UX.

---

## 4. Knowledge graph — structure

### Scopes

- ✅ **Two scopes**
  - `user` and `agent`, with a strict privacy partition.
- ✅ **Cross-scope linking disallowed**
  - Enforced at the data layer; prevents agent-scope leakage via reference chains.
- ✅ **Per-agent partitioning within agent scope** (multi-agent-ready, N=1 at MVP)
  - Agent scope is partitioned per-agent via `wiki_pages.agent_id`. Each agent owns its own subtree rooted at its agent's `root_page_id`. RLS filters agent-scope reads by `(user_id, scope='agent', agent_id=<active session agent>)`. Cross-agent reads disallowed even within the same user. See `specs/agents-and-scope.md`.
  - MVP ships with one seeded `Assistant` agent per user; custom agents are V1+ without schema migration.

### Page types

- ✅ **User-scope type set**
  - person, concept, project, place, org, source, event, note, profile, todo. (`topic` dropped with the topics abstraction; `profile_*` collapsed to a single `profile` type organized via hierarchy; `todo` added so reminders and commitments have a dedicated home rather than bloating `note`; `research` dropped as a wiki type — research outputs are artifacts in `research_outputs`, not wiki pages. Text artifacts re-ingest into the wiki via standard types when relevant.)
- ✅ **High-churn types (flag)**
  - `todo` (and likely `event` later) are flagged as **high-churn ephemeral types** — high volume, repeated titles, frequent reparenting through status buckets. They use a different slug strategy (see Hierarchy § Slug uniqueness). Semantic long-lived types (`person`, `project`, `concept`, `profile`, `source`) use the standard walk-up rule.
- ✅ **Agent-scope type set**
  - Single type: `agent`. One root page per agent (slug = agent slug, e.g. `assistant`, `health-coach`); all subsequent agent-scope pages descend from that agent's root via `parent_page_id`. Each root page carries `agent_id` pointing at the owning `agents` row. Lets the agent scope grow organically per agent before we commit to a typology. Mirrors the hierarchy-based pattern used for `profile`.
- ✅ **Profile sub-type handling**
  - Single `profile` type organized via hierarchy. One top-level `Profile` page per user with child pages (`Goals`, `Values`, `Health`, `Work`, `Interests`, `Relationships`, `Preferences`, `Psychology`) each also of type `profile`. Fan-out routes by parent + canonical child slug. Removes the `profile_*` type proliferation; aligns with the hierarchy-as-nesting-mechanism decision.

### Hierarchy

- ✅ **Mechanism**
  - `parent_page_id` self-reference on `wiki_pages`. Unlimited nesting.
- ✅ **Max depth**
  - No enforced limit. YAGNI. May surface as a linting recommendation later if pages grow pathologically deep.
- ✅ **Cycle prevention**
  - App-level check on reparent (walk ancestor chain from proposed new parent; reject if it hits the page being moved), with a DB trigger as safety net.
- ✅ **Reparenting**
  - Allowed. Slug does not auto-change on reparent — slugs are stable identifiers.
- ✅ **Tombstone cascade behavior**
  - Block tombstone when the page has non-tombstoned children. User must reparent or tombstone children first. Acceptable friction given voice-first, low-volume manual edits.
- ✅ **Filesystem invariant**
  - `UNIQUE (user_id, scope, parent_page_id, title)`. Duplicate titles among siblings are structurally impossible.
- ✅ **Slug uniqueness — two-track strategy**
  - Slugs are globally unique per `user_id + scope`. Generated at creation, persisted, stable across reparents. Strategy depends on page type:
  - **Standard (long-lived semantic types — `person`, `project`, `concept`, `profile`, `source`, `place`, `org`, `note`):** walk-up rule. Kebab-case of title; if collision, prepend parent slug; if still collision, prepend grandparent, walking up until unique. Numeric suffix (`-2`, `-3`, …) as last-resort fallback when walk-up exhausts.
  - **High-churn types (`todo`, and likely `event` later):** `{kebab-title}-{short-hash}` where the hash is a stable 4-character disambiguator derived from the page's UUID. No walk-up, no collision management. Motivated by systematic reparenting (todos cycling todo → in-progress → done → archived) which otherwise produces silent slug fragmentation as new pages are created in vacated buckets.
- ✅ **`parent_slug` denormalization**
  - Not added to `wiki_pages`. Join via `parent_page_id` is cheap; breadcrumbs use a recursive CTE. Can revisit if a hot path demands it.

### Topics (dropped)

- ✅ **Topics vs. hierarchy decision**
  - **Dropped.** Hierarchy (`parent_page_id`) covers nested grouping; `tags` cover cross-cutting grouping. `topics` / `wiki_page_topics` tables and the `topic` page type are removed from the model. Architecture doc needs a pass to reflect this.

### Todos

- ✅ **Todo lifecycle shape**
  - Each todo is its own `wiki_page` (type=`todo`). Status changes (pending → active → complete → archived) are expressed as reparent operations across seeded bucket pages. Uses the hierarchy mechanism rather than a status column on the page.
- ✅ **Seeded structure**
  - Root page `todos` (type=`todo`) seeded per user. Four child bucket pages seeded beneath it: `todo`, `in-progress`, `done`, `archived` — each also type=`todo`. Individual todos live as children of whichever bucket matches their current status.
- ✅ **Project-scoped todo lists**
  - Child `todo` pages are allowed under `project` pages for project-specific task lists. Hierarchy handles it naturally (e.g., Consensus project can have its own `todos` child page with the same four-bucket structure, or a flatter list — flexible).
- ✅ **Per-todo metadata (frontmatter)**
  - `assignee: user | agent`, `priority: low | medium | high | urgent`, `due_at` (optional), `created_at`. Lives in the `frontmatter` jsonb column on `wiki_pages`. Sub-tasks are just child `todo` pages under their parent todo.
- ✅ **Entry sources**
  - User-added via UI, user-spoken in a call ("remind me to…" fanned out into todos), AI-detected implicit commitments from transcript ("I told Alex I'd send him the paper"), proactive recommendations promoted to todos.
- ✅ **Separation from notifications**
  - Todos = things the user intends to do. Notifications = things the user should be aware of (task completions, pending confirmations, recommendations). A drafted email is a *notification* ("email ready to review"), not a todo.
- ⏺️ **Scheduled-reminder firing** (V1+)
  - "Remind me at 3pm to call Sarah" depends on scheduled-task infra (§12). MVP todos are a plain checkable list surfaced when the user opens the app.
- ✅ **Todos UI module (core, not a plugin)**
  - A dedicated "Todos" UI surface renders todos with task-management UX (status tabs, check-off, due dates, sub-tasks, assign-to-agent) without changing the underlying data model. The client app queries `wiki_pages WHERE type='todo'` joined with `agent_tasks` for agent-assigned tasks' live status. Users can create todos directly from the UI (writes a wiki page like any other); check-off is a reparent to `todos/done`; etc. Wiki UI still exposes the raw bucket-page hierarchy as an escape hatch. Not a plugin — core built-in surface, data-fetching + filtering logic lives client-side. See §15c.

### Mutability

- ✅ **Append-only at fact level**
  - Newest-wins on read.
- ✅ **Personal vs. objective facts**
  - Personal superseded by newest; objective not overwritten by newer contradictions.
- ✅ **User edits tombstoned**
  - Not hard-deleted, to preserve undo.
- ✅ **History snapshots**
  - Full content snapshots in `wiki_section_history` for every edit. Page-level creation / tombstone events captured in `wiki_log` instead.
- ✅ **Chronologically-oriented page format**
  - Simple list of entries ordered newest → oldest. No `current`/`superseded` markers. No separate "Current" + "History" sections. Consumers (AI in preload, user in UI) weight recency but don't discount older entries — attitude and view changes over time are meaningful context.
- ✅ **Timeline section (contradiction handling)**
  - **Uniform rule, all page types:** the default page shape is one or more ordinary `wiki_sections`. A special section — `title = 'Timeline'` — is added *only when a contradiction arrives*. No advance ephemeral/evergreen tagging of claims. Timeline acts as both a page structure element AND the conflict-resolution mechanism. Enabled cleanly by the sectioned data model: Timeline is just another row in `wiki_sections`.
  - **Contradiction definition (for the fan-out prompt):** two claims cannot simultaneously be true about the same subject. *Additive* claims (more goals, more friends, more projects) are not contradictions. Claims about fundamentally 1:1 attributes (current residence, primary job, marital status) are contradictions. Ambiguous cases — especially attitudes, beliefs, self-assessments — default to Timeline, because preserving evolution is more valuable than collapsing it.
  - **Reclassification:** when a contradiction arrives and the superseded claim lived in some other section, fan-out must (a) remove it from that section's content and (b) add it as a Timeline entry with a `Past` (or best-effort-dated) annotation. The new claim enters Timeline as `Current`. If a prior `**Current**` entry for the same attribute already exists in Timeline, it is demoted to `**Past**` (dated if inferable) before the new `**Current**` is inserted. Detailed operation + carveouts for refinement/correction live in `specs/fan-out-prompt.md` §4.4.
  - **Timeline ordering:** entries ordered by **ingest time, newest-first** (consistent with the chronological page-format rule). Each entry carries a temporal annotation — `Current`, `Past`, or a specific date when available. The consuming LLM synthesizes from the list; no need to enforce strict event-chronological order.
  - **Timeline entry format:** flat bullet list within the Timeline section's `content`. Each bullet starts with a bold temporal annotation (`**Current**`, `**Past**`, `**April 2026**`, `**Since March 2025**`, `**2024**`), then an em-dash, then the claim.
  - **No sub-grouping within Timeline.** Flat newest-first, never categorized by attribute. If a Timeline appears to need sub-grouping, that's a signal the page's content belongs on separate pages (resolve via hierarchy, not section structure). This is a design principle, not just a prompt rule.
  - **Section ordering:** Timeline is conventionally the first section on any page where it exists. Enforced by prompt rule for MVP (backend enforcement if the prompt drifts).
  - **Consumer behavior:** when Audri reads a page, non-Timeline sections are weighted as authoritative-by-default; Timeline is interpreted as a recency-weighted history where the newest entry is the current state unless superseded by a specific-dated claim.
- ⏺️ **Notes refactoring policy** (deferred)
  - Does the AI migrate content from freeform `note` pages onto canonical pages over time? Deferred for MVP — fan-out routes claims directly into canonical pages from the start, so free-floating notes should be rare. Revisit if notes accumulate promotion-worthy knowledge.

### The index

- ✅ **Index as materialized view**
  - Not a stored file; API endpoint over `wiki_pages`.
- ✅ **Markdown rendering on demand**
  - For system-prompt injection at call start.
- ✅ **Per-page agent abstract + human abstract**
  - `agent_abstract` (required, terse, machine-consumed) and `abstract` (nullable, human-readable lead) on each page. Both AI-regenerated on page-touching writes. See §3 core tables.
- ⏺️ **Abstract regeneration trigger**
  - Always regenerated inline with fan-out writes that touch the page (no separate pass). Open question: should purely-cosmetic section reorders/metadata edits also trigger regeneration? Relates to §17 cost strategy.

### Log

- ✅ **`wiki_log` shape**
  - Append-only chronological record with kinds (ingest, query, lint, task).
- ⏺️ **`wiki_log` retention / rollup**
  - Policy for log growth — it will grow fast.

---

## 5. Sources & grounding

- ✅ **Grounding principle**
  - Every fact in the KG is grounded; generalizes to every derived artifact.
- ✅ **Source kinds + linking model**
  - Section-level per-entity junction tables (see §3 core tables): `wiki_section_transcripts`, `wiki_section_urls`, `wiki_section_ancestors`, `wiki_section_uploads` (V1), plus per-artifact-kind junctions for re-ingesting artifacts (`wiki_section_research`, V1 `wiki_section_briefs`). User edits live in `wiki_section_history.edited_by='user'` — no dedicated source row.
- ✅ **Generalized artifact-source linking**
  - **Resolved: per-entity junctions at section granularity.** Replaces both the polymorphic-table and earlier page-level junction proposals. See §3.
- ⏺️ **Sources & grounding conventions** — **SPEC**
  - Inline citation style in rendered markdown (footnote vs. inline link vs. both); retention policy when a superseding fact arrives (keep vs. prune); per-claim vs. per-page UI surfacing.
- ⏺️ **UI surfacing of sources**
  - Dedicated sidebar on every page? Hover citations? Drill-down view?
- ⏺️ **Contextual source creation affordances**
  - From any wiki page, upload a source directly to that page (no context switch). From a source, spawn research / podcast / brief from it. From a transcript, drill into touched pages inline. See `notes/data-flow-architecture.md` §Audit-trail affordances.
- ⏺️ **Feeds as sources (content partnerships)** — V1+ business model
  - Partner with news / content organizations to ingest their content as user-specific RSS (or equivalent) feeds. Treated as a special source kind — ingested on schedule, same fan-out pipeline, provenance carries the partner identity for revenue-share accounting. Out of MVP scope but flag the source-table shape to accommodate a `feed` source kind without refactoring.
- ⏺️ **Bidirectional lookup performance**
  - Reverse index from source → pages (e.g., "all pages this transcript sourced") is a two-JOIN lookup against the section-level junctions → `wiki_sections` → `wiki_pages`. Materialized view may be warranted for high-volume users; live query fine at MVP scale.

---

## 6. Knowledge graph — ingest pipeline (server-side)

- ✅ **Rough shape drafted**
  - Classify noteworthiness → fan-out to pages → regen summaries → write `wiki_log`.
- ⏺️ **Fan-out pipeline full design** — **SPEC**
  - Tabled for dedicated conversation. Subcomponents listed below. (architecture.md §Open questions)
- ✅ **Ingestion runs through Graphile Worker on dedicated `ingestion` queue**
  - Transcript commit enqueues an ingestion Graphile job (`queue_name='ingestion'`, `job_key=user_id` for per-user serialization). Worker picks up → runs Flash + Pro + transactional commit → on completion, any agent-assigned todos extracted from commitments are written to `agent_tasks` and enter the separate `agent_tasks` queue.
  - Gains: natural backpressure if many calls end simultaneously; resolves the per-user concurrency open question (two quick-succession calls can't race on the same pages); uniform retry/observability with the rest of the queue infra; independent concurrency tuning from agent-tasks.
  - No dedicated `ingestion_jobs` table — Graphile's job table is sufficient; domain record is the `call_transcripts` row; `wiki_log` captures ingest events for provenance.
- ✅ **Noteworthiness classifier — per-claim, inside Pro**
  - Per-claim noteworthiness lives in Pro's main prompt (stage 3 of the pipeline), not as a separate Flash classifier. Skip-default with explicit per-type bar adjustments (higher for `profile`, lower for `todo`/`note`). Restated facts skipped silently. Fully specified in `specs/fan-out-prompt.md` §4.2; tradeoff entries in `tradeoffs.md`.
- ✅ **Routing + entity disambiguation location — inline in Pro fan-out**
  - Pro fan-out prompt handles both routing (claim → existing page vs. new page) and entity disambiguation (voice surface form → canonical slug) in a single pass, constrained to Flash's candidate set. Flash does coarse retrieval (which pages are candidates); Pro does fine per-claim arbitration. See `tradeoffs.md`.
- ✅ **Preloaded slice shape — Flash's candidate set**
  - Backend preloads full joined content (sections) for every slug in Flash's `touched_pages`. Pro receives: transcript + compact wiki index (all pages, `agent_abstract`-only) + full joined content of Flash's candidates + the `new_pages` plan. Flash candidate emission replaces a deterministic hot-set heuristic. See `tradeoffs.md`.
- ✅ **No `fetch_page` fallback for MVP**
  - Pro is bounded by Flash's candidate set. No tool use, no two-pass retry, no post-hoc miss-recovery. Accepts recall risk as an MVP tradeoff. Refactor paths documented in `notes/ingestion-pipeline.md`. See `tradeoffs.md`.
- ✅ **Routing rules within the Pro prompt**
  - Five-rule routing (multi-target / existing-match / new-match / no-fit-skip / premature-create-guard) + empty-update suppression + multi-target phrasing convention. Fully specified in `specs/fan-out-prompt.md` §4.3. Multi-target writes captured as a tradeoff entry.
- ⏺️ **Conflict resolution**
  - Newest-wins vs. objective-fact protection.
- ⏺️ **Idempotency**
  - What happens if a transcript is reprocessed.
- ⏺️ **Partial-failure recovery**
  - One page write fails out of twenty; retry / rollback semantics.
- ✴️ **KG parsing prompt (CLAUDE.md analogue)** — **SPEC** in progress
  - Draft spec at `specs/fan-out-prompt.md`. All decision rules (claim extraction, noteworthiness, routing, contradiction handling, skip criteria, source attribution) fully specified. Remaining: prompt-text drafting (identity / role / ontology primer / examples), worked examples, evals.
- ✴️ **Flash candidate-retrieval prompt** — **SPEC** in progress
  - Draft spec at `specs/flash-retrieval-prompt.md`. Decision rules locked: full-index input dump (MVP), slug-only touched payload, `{proposed_slug, proposed_title, type}` for new pages, recall-biased flagging, implicit noteworthiness gate via empty arrays, commitment-pattern → unconditional `todos/todo` flag, `User:`/`Audri:` speaker handling. Remaining: prompt-text drafting (identity / role / ontology primer), worked examples, evals.
- ✅ **Agent-scope ingestion pass** — **SPEC** complete
  - Separate, lightweight pass distinct from Pro user-scope fan-out. Runs Flash (not Pro); input = transcript + active agent's private wiki; output = append/update notes under the active agent's root page. Strict scope isolation — never emits to user-scope, never crosses agents. Spec at `specs/agent-scope-ingestion.md`. Chunks 1 + 2 both ✅ — see below.
  - **Chunk 2 (decision rules)** ✅:
    - **Three observation categories**: (1) behavioral patterns — how user communicates/decides/prioritizes; (2) recurring concerns / interests — themes the user keeps returning to; (3) stated preferences not yet promoted to `profile/preferences`.
    - **NOT recorded**: facts about the user's world (those go to user-scope), things the user explicitly stated as fact, single-call low-substance ephemera, content of *what* was said (observations are about *how* + patterns).
    - **Skip-default — but on SUBSTANCE, not repetition.** The agent's wiki IS its only cross-call memory; un-recorded observations are lost forever. Skip when low-substance / vague / unanchored, OR when the observation is actually a user-scope fact in disguise. Otherwise **record on first instance when substantive** — specific, anchored to call evidence. Subsequent calls evolve the record (confirm patterns, refine understanding, tombstone observations that turned out one-off).
    - **Where observations land**: persona-specific seed pages — Assistant gets `assistant/observations`, `assistant/recurring-themes`, `assistant/preferences-noted`, `assistant/open-questions` (seeded at agent creation). Auto-create new sub-pages above threshold (~3 distinct calls referencing pattern + parent page > ~500 words); below threshold, append to parent's relevant section.
    - **No multi-target writes** — each observation lands on exactly one page; if plausibly two, pick most-specific.
    - **Refresh discipline (hybrid)**: append for new patterns (new section / new bullet); in-place section update for refined understanding of existing observations. No Timeline section. Agent decides format within sections (markdown allowed but not required; not user-facing).
    - **Source attribution (relaxed vs. user-scope)**: snippet citations only on *substantive* observations (new pattern, specific behavioral note, anchoring quote). Light updates that don't introduce new claims don't require snippets — observations are often gestalt-based and force-citing single turns would mis-represent the basis.
    - **Persona scopes WHAT to observe** via `persona_summary`; scaffolding governs HOW to write (skip-default, no cross-scope reads, snippet discipline, persona-appropriate seeded pages).
    - **Privacy reaffirmation in prompt**: never reference user-scope facts directly, never reference other agents' observations. Backend stamps `agent_id` + `scope='agent'` (LLM cannot fabricate cross-scope writes).
    - **`skipped` array carries brief reasons**: `"low-substance, no anchoring evidence"`, `"user-scope fact, not an observation"`, `"already captured in {existing_page} with no new nuance"`, `"too speculative — would require fabrication to be specific"`.
    - **Empty output is valid**. Many calls produce 0 writes (short, pure-action). Soft volume guidance: most calls 0–2 writes; long content-rich calls 3–5; >5 is suspicious. No hard cap.
  - **Chunk 1 (pipeline shape + I/O contract)** ✅:
    - **Trigger:** every successfully-committed transcript fires agent-scope ingestion in parallel (not sequential) with user-scope fan-out. Both jobs enqueue to `ingestion-${user_id}` queue (per-user serialization across both); independent failure isolation. User-cancelled transcripts (`call_transcripts.cancelled=true`) skip agent-scope same as user-scope.
    - **Model tier:** single Flash call, no companion retrieval pass. Active agent's private wiki loads entirely (small at MVP per `specs/agents-and-scope.md`).
    - **Input:** `{ transcript, agent_wiki: {agent_slug, persona_summary, pages[]}, user_profile_brief: {name?, timezone?}, call_metadata: {started_at, ended_at, end_reason} }`. Persona summary scopes what's worth observing per persona. Minimal user_profile_brief (no full user-scope wiki) — observations are about user *patterns*, not user *facts*. Per-call scope only — no cross-call context in input; cumulative observation flows via the agent's own existing-page updates.
    - **Output:** structured `{creates[], updates[], skipped[]}` symmetric with user-scope fan-out but simpler — no Timeline section, no multi-target writes, no contradiction detection. Section keep/update/create/tombstone semantics preserved. `agent_id` and `scope='agent'` injected by backend (LLM never emits — same security invariant as user-scope).
    - **Backend commit:** single transaction inserting `wiki_pages` (with `scope='agent'`, `agent_id`), `wiki_sections`, `wiki_section_history` (`edited_by='ai'`), `wiki_section_transcripts` (per snippet — same junction as user-scope), `wiki_log` (new event kind `'agent_scope_ingest'`).
    - **Failure handling:** independent from user-scope. Conservative retry per §11 Chunk 4 (max 1–2 attempts, RetryableError only). Agent-scope failures don't block user-scope. No user-facing surface for agent-scope failures (private internal notes); Sentry-only.
    - **No noteworthiness gate at MVP** — always-on; Flash cost low enough that gating doesn't pay off.
- ⏺️ **Wiki seeding protocol** — **SPEC**
  - Exactly what's pre-populated on account creation (stub profile pages, per-agent root + optional seed subtree, Audri's initial self-description). Now covers: default `Assistant` agent row + its root page + starter child pages under the root. (architecture.md §Open questions)
- ⏺️ **Uploaded-source ingest pipeline**
  - URLs, files, images (OCR + vision), audio. Mirrors transcript flow. (features.md §Knowledge ingestion)
- ⛔ **Email ingest (received email as context)**
  - Depends on §15 integrations.

---

## 7. KG maintenance (linting / healthcheck)

- ⏺️ **Linting / healthcheck background flow** — **SPEC**
  - Cadence, triggers, checks (orphans, contradictions, stale claims, missing cross-refs, split candidates), autonomous-action scope vs. surfaced recommendations. (architecture.md §Open questions)
- ⏺️ **Split-recommendation trigger**
  - Token threshold per page; proposal flow into the activity stream. (features.md §Proactive recommendations)
- ⏺️ **Auto-split long pages**
  - Scheduled lint scans for pages exceeding `MAX_LENGTH` (working threshold: ~2k words / ~2500 tokens). Proposes or executes a split into nested child pages. Decision: autonomous vs. confirmation-required (lean confirmation-required for MVP — splits are high-impact and hard to reverse without page history).
- ⏺️ **Auto-merge suggestion**
  - Adjacent to split: detect near-duplicate pages / fragmented entity references and propose merging. Partially overlaps with entity-merge detection below.
- ⏺️ **Entity-merge detection**
  - Auto-propose vs. rely on user.
- ⏺️ **Cluster-to-project elevation**
  - Detect when a set of related notes/concepts has grown into an implicit project; propose creating a `project` parent and reparenting the cluster under it. Sibling of split-recommendation and merge-detection.
- ⏺️ **Broken-wikilink repair**
  - Autonomous fix vs. recommendation.

---

## 8. Call mode

### Done

- ✅ **Persists through screen-lock**
  - Background audio session maintained.
- ✅ **Call-end summary + action-item confirmation**
  - Baseline end-of-call UX shape.
- ✅ **In-call read-only KG access**
  - Preloaded slice + `search_graph` tool; writes disallowed.
- ✅ **Post-call transcript upload**
  - Stored immutably; listed in Call History.
- ✅ **Voice prototype validated**
  - Sandbox proven: Gemini Live plumbing, mic gating, per-buffer onEnded, proactive greeting, system prompt.
- ✅ **Persona loading at session start**
  - Call initiation carries `agent_slug` (defaults to `assistant`). Server composes system prompt as: base Audri scaffolding + active agent's `persona_prompt` + `user_prompt_notes` + user-wiki preload + active agent's private-wiki preload. Voice configured from `agents.voice`. See `specs/agents-and-scope.md`.

### Open

- ⏺️ **Preloaded slice contents** — **SPEC**
  - Full index always; which agent-scope pages; which recent user-scope pages; token budget. Cost-sensitive. (architecture.md §Open questions)
- ⏺️ **Active-project prioritization in preload**
  - "Hot" projects (user-pinned, recent activity, high call frequency) deserve full content in the preload, not just an index entry. Decide the signal set and the storage mechanism (pin flag on `wiki_pages`? derived from `wiki_log`?).
- ⏺️ **Call agent system prompt** — **SPEC**
  - Audri's in-call voice, behavior, boundaries, tool-use policy. (architecture.md §Open questions / "Prompts to write")
- ⏺️ **`search_graph` tool spec**
  - Inputs (slug vs. query vs. both), return shape, pagination, ranking. Relates to §18 search.
- ⏺️ **Call-end flow** — **SPEC**
  - Action-item surfacing, amend flow, cancellation flow, early-drop handling (unconfirmed items → notifications feed per features.md).
- ✅ **Session initialization architecture** (Chunk 1 of §8)
  - **Server composes, client uses.** Client calls `POST /calls/start` with `{ agent_slug, context_page_id?, call_type }`; server validates + assembles composed system prompt + Gemini Live config + level-4-filtered capability list; returns to client. Client initiates Gemini Live WebSocket directly (no server proxy for audio).
  - **Call-types for MVP: `generic` | `onboarding`.** All other variants (contextual, task-specific) backlogged V1+. Onboarding uses a distinct scaffolding cache (onboarding interview prompt), skips preloaded wiki slice (stubs only) + recent activity (none yet). Capability advertisement during onboarding is *slightly proactive* (see `specs/onboarding.md`) — tied to stated needs, one mention per natural opening, no upfront menu.
  - **Request deduplication**: client-side debounce (500ms) + server-side "return existing session if called within 2s for same (user_id, agent_id)."
  - **Fail fast on init errors** — agent not found (404), tier cap exceeded (402 + upgrade CTA), Gemini unavailable (503 + retry message). No session-init queuing; calls are real-time.
- ✅ **Prompt composition layers** (outer → inner, server-assembled)
  - Layer 1: Static call-agent scaffolding — Gemini explicit cache (shared across users + sessions; one version per cache ID).
  - Layer 2: Persona — `agents.persona_prompt` + optional `agents.user_prompt_notes`. Injected as system-prompt text, not as a separate turn. Cannot override scaffolding invariants (soft prompt discipline + runtime tool gates for hard enforcement).
  - Layer 3: Ontology primer — brief wiki-model description (pages, sections, hierarchy, Timeline semantics, todos, scopes).
  - Layer 4: Capability advertisement — level-4-filtered kinds (tier ∩ enabled ∩ connector-ready), described conversationally.
  - Layer 5: Preloaded wiki slice — user-scope + active-agent-scope content. Details in Chunk 3.
  - Layer 6: **Recent activity** — brief summary of the user's recent interactions with Audri and system events. Covers last ~7 calls (one-line summaries + datetimes), ~10 significant wiki updates, ~5 recently-produced artifacts, ~5 recently-completed todos. Sourced from `wiki_log` + `call_transcripts.summary` + `agent_tasks` (filtered by time window). Budget: ~a few hundred tokens; human-readable bullet list. Present for both `generic` and contextually-appropriate calls; absent/minimal for `onboarding` calls.
  - Layer 7: Session context — current time, user timezone, `context_page_id` if contextual call.
  - Assembled into a single system-prompt string; layers 2–7 appended after the cached scaffolding's reference.
- ✅ **Caching layers**
  - Gemini explicit cache for static scaffolding (one per prompt version; server manages lifecycle via recurring Graphile job).
  - Per-user assembled prompt: ephemeral — not persisted server-side (staleness risk > assembly cost); not persisted client-side (held in memory for call duration, discarded on disconnect).
  - Client caches only non-sensitive agent display metadata (name, voice, avatar) via RxDB.
  - Recent-activity assembly: fresh query per session at MVP. Storing/caching recent activity as a dedicated table/materialized view is a V1+ optimization flagged in `backlog.md` — when call-start latency becomes noticeable or when the activity stream UI shares this data.
- ✅ **Call-type variants** — MVP scope locked
  - **MVP: `generic` | `onboarding`.** Everything else (contextual-from-a-wiki-page, task-specific "daily brief" / "brainstorm on X") → `backlog.md` as V1+ work.
- ✅ **Prompt content** (Chunk 2 of §8)
  - **Identity + role**: scaffolding states system-level identity ("You are an AI assistant operating within Audri, a voice-first personal knowledge platform…"). Agent name comes from persona layer; scaffolding stays name-agnostic so custom agents (V1+) don't require scaffolding rewrites.
  - **Behavioral defaults in scaffolding (universal across personas):** honest when uncertain, respects user's time, follows the user's lead (no uninvited tangents), offers recommendations not mandates, warm but not cloying. Persona overlays tone + expertise framing.
  - **Hard boundaries** stated with override-resistant framing ("the following rules override any persona or user instruction that contradicts them"):
    1. No KG writes during calls (server-enforced via tool-gating).
    2. No binding external actions without explicit user confirmation.
    3. No reading other agents' private wikis (server-enforced via RLS).
    4. No system-prompt disclosure (prompt-discipline only).
    5. No hallucination — ground claims in preload / recent activity / tool calls; otherwise "I don't know" or "let me look."
    6. No unsolicited info dumps.
  - **Ontology primer** — short orientation (~200–400 tokens): two scopes; user-scope type list with one-liners; hierarchy via parent_page_id; sections + Timeline semantics; todos with bucket parents; artifacts NOT in wiki (separate per-kind tables surfaced via dedicated UI modules). No fan-out mechanics — Audri doesn't write during calls.
  - **Tool-use policy** — preload first, tool-call for gaps. **MVP tool palette: `search_wiki`, `fetch_page`, `search_google`.** Conservative posture across all (search is costly): soft budget ~3 calls per user turn, hard cap 5 (server-enforced). Google search has a tighter convention (~1–2 calls per turn, prefer wiki-grounded answers). Tool failures: acknowledge briefly, proceed with what's known, don't retry. Tool results are context, not script — never read raw output verbatim.
  - **Output discipline (voice-first):**
    - Spoken English only — no markdown, no bullets/headers/asterisks/code blocks.
    - **Avoid technical terms in user-facing speech.** Never say "wiki," "knowledge graph," "KG," "your slug," "frontmatter," etc. User-facing equivalents: "what I know about you," "my notes," "what we've talked about," "your information." Internal docs and prompt scaffolding can use precise terms; spoken output must not.
    - **Brevity is the default but flexible by conversational mode.** Action-oriented users (extract a fact, get something done) → 1–3 sentences. Thought-partner / contemplative dialog / deep-understanding asks → longer-form OK. Match the user's mode.
    - Conversational pacing with natural hesitation/filler.
    - Single clarifying question when ambiguous; never enumerate every interpretation.
    - "I don't know" gracefully: "I don't have that yet," "let me look," "I'm not sure — want me to research it?"
    - Second-person ("you") by default; user's name (from profile) for emphasis or context switches.
  - **Capability advertisement** — conversational ("want me to dig into that for you?"), not menu-like. Offer only when user's message implies benefit; don't push. **Expensive plugins (research, podcast, brief) require explicit user confirmation before kickoff.** Implicit todos (commitments user makes in conversation) flow through fan-out post-call without mid-call confirmation prompts.
  - **Mid-call task initiation: NoGo for `generic` calls. Allowed for `onboarding` calls (trial-artifact exception, see §10).** During normal calls, Audri acknowledges agent-task requests conversationally ("I'll research that once we wrap — you'll get a notification") and lets fan-out's implicit-commitment path create the agent_task post-call.
  - **Persona-breaking / system-prompt disclosure:** polite refusal pattern that describes behavior plainly without invoking system-prompt language. "I can tell you how I behave: I try to help you think through things, keep track of what matters to you, and handle tasks you want done. I don't share the exact instructions I operate on." Never confirm internal mechanics ("are you using a preload?" → answer at user-observable level).
- ✅ **Preloaded wiki slice** (Chunk 3 of §8)
  - **Six components** assembled in priority order (truncate later categories if budget hits):
    1. Wiki index — every active page as `{slug, title, type, parent_slug, agent_abstract}`. Same shape Flash sees (`specs/flash-retrieval-prompt.md` §4.1).
    2. Profile content — full sections for `profile` root + 8 children. Always loaded (foundational).
    3. Active-project content — pages of `type='project'` selected by activity (B1 below); full sections.
    4. Recently-touched pages — `updated_at > now() - 14 days` ordered DESC, fitted to remaining budget; full sections.
    5. Active agent's private wiki — every `scope='agent' AND agent_id={active_agent}` page; full subtree (small at MVP).
    6. (Person pages: indexed always, full only when recently-touched. Sources / notes / events: index-only — tool-call for full content.)
  - **Active-project signal: activity-derived for MVP** — `WHERE type='project' AND updated_at > now() - 14 days ORDER BY updated_at DESC LIMIT 5`. No explicit user-pin UX at MVP. Explicit pinning logged in `backlog.md` as V1 work.
  - **Token budget — conservative**: target ~7–10k for the preload slice; ~15k hard cap on the slice itself; total system-prompt budget target ~13–15k, cap ~20k. Tighter than initially proposed; willing to revisit upward only if recall suffers visibly. Server assembles in priority order; if cap is approached, log an `info` entry + truncate yieldable categories (active-projects, then recently-touched). When the wiki index alone exceeds budget (hundreds of pages per user), trigger the same Flash-style retrieval refactor flagged for ingestion (already in `backlog.md`).
  - **Onboarding variant** — preload is ~1–2k total. Wiki index = stubs, profile pages = stubs, active projects/recently-touched/agent-scope = empty. Layer 6 (recent activity) omitted entirely. Capability advertisement (Layer 4) more prominent. Onboarding scaffolding directs Audri to discover interests, propose trial artifacts, fill profile pages.
  - **Refresh discipline** — preload composed once at session start, immutable for the session. No mid-call refresh. Tool calls (`search_wiki`, `fetch_page`) hit live data — escape hatch for staleness.
  - **Format** — markdown sections, page-shape mirrors `fetch_page` output. Wiki index as compact bulleted list. Top-level sections: `Profile`, `Active projects`, `Recently-touched`, `Wiki Index`, `My notes about you` (last header user-facing-ish; avoids "wiki"/"KG" jargon per Chunk 2 §E2).
- ✅ **Tool palette** (Chunk 4 of §8)
  - **MVP tool set:** `search_wiki`, `fetch_page` (server-implemented, declared in `gemini_config.tools` at session init). **Plus Gemini Live's built-in Google search grounding** (config flag, not a custom tool — see web-grounding decision below). No `queue_trial_artifact` at MVP — onboarding trial artifacts deferred to backlog (V1+).
  - **`search_wiki`** — input `{ query, type?, limit? (default 10, hard cap 25) }`; returns ranked results `{slug, title, type, agent_abstract, score, matched_section_titles}`. Postgres FTS on `wiki_sections.content` + page metadata, ranked by `ts_rank_cd` weighted toward title matches. pgvector embeddings deferred V1+. No pagination at MVP. Scope = caller's user-scope wiki only (no agent-scope, no cross-user).
  - **`fetch_page`** — input `{ slug }`; returns full joined page (same shape Pro fan-out reads). Latest version only — history not exposed. Tombstoned slugs return null + `info` log. Cross-scope rejection at server (agent-scope pages not fetchable; returns null + `warn` log).
  - **Web grounding via Gemini Live built-in (MVP).** Native flag in `gemini_config`; Google handles search invocation + citation grounding inside the model. Conservative posture by limiting the flag's allowance and per-session toggle. Custom `search_google` tool + provider abstraction deferred V1+ (see backlog) — migration triggers: per-call cost visibility, provider swap, fine-grained budget control. At migration, swap built-in flag off + plug `search_google` tool with provider behind it (Tavily likely candidate).
  - **`queue_trial_artifact` (onboarding-only)** — deferred to V1+ (see backlog). MVP onboarding has no mid-call task kickoff.
  - **Tool-error handling:** tool errors don't fail the call. Audri acknowledges + proceeds + never retries within a turn. Security violations (e.g., `queue_trial_artifact` invoked in generic call) → hard reject + `warn` to Sentry (possible prompt injection).
  - **Tool-call observability:** every tool call emits structured log with correlation context (`session_id, tool_name, input_summary, status, duration_ms`). Web-grounding calls emit `usage_events` with `event_kind='live_grounded_search'` *if* Gemini Live exposes per-call attribution; otherwise grounded-search cost rolls into the Live session bill.
  - **Tool-call latency budget:** sub-100ms `search_wiki` (FTS indexed); sub-50ms `fetch_page` (single joined read); sub-50ms `queue_trial_artifact` (insert + enqueue). Live's built-in grounding latency is Google's responsibility.
  - **New schema additions for MVP:**
    - `call_transcripts.tool_calls: jsonb` (nullable) — captures tool invocations + results for transcript ingestion to attribute claims to URLs (`wiki_section_urls`). Even with built-in grounding, Live emits citation metadata that should land here.
    - `agent_tasks.is_trial: bool` deferred to V1+ alongside trial-artifacts feature.
- ✅ **Transcript + call-end flow** (Chunk 5 of §8)
  - **Transcript format**: turn-tagged JSON in `call_transcripts.content`. Each turn carries `{turn_id (T0..Tn monotonic), speaker ('user' | 'agent' — never persona name), started_at, ended_at, text, tool_calls?, was_interrupted?}`. Tool-call records inlined per-turn AND aggregated in `call_transcripts.tool_calls` jsonb (per-turn for readability, aggregated for ingestion-time queries). No interim/partial transcripts persisted — only finalized turns. `turn_id` carries through to `wiki_section_transcripts.turn_id` for source attribution.
  - **Two-phase call-end:** in-call summary turn from Audri (action-items requiring confirmation only; never recap silent ingestion) → user confirms / amends / drops conversationally → user signals end → client posts to `POST /calls/:session_id/end`.
  - **`POST /calls/:session_id/end` payload:** `{ transcript, ended_at, end_reason, confirmed_items?, unconfirmed_items? }` where `end_reason ∈ {user_ended, silence_timeout, network_drop, app_backgrounded, user_cancelled}` and `confirmed_items` carries `{turn_id, description, status: 'confirmed' | 'dropped'}` for user-explicit confirmations during recap.
  - **Server commit + enqueue is atomic** — single transaction inserts `call_transcripts` row + writes `dropped_turn_ids` + atomic `add_job` to the `ingestion` Graphile queue (`queue_name='ingestion-${user_id}'` for per-user serialization). Endpoint returns as soon as the transaction commits; ingestion handler runs asynchronously when worker picks up the job (never synchronous inside the request). Idempotent on `session_id` — duplicate posts return `{already_committed: true}`.
  - **Confirmation gates only agent-executed actions**: agent-assigned todos that become `agent_tasks` (research, drafts, events), connector writes (V1+). Wiki updates + user-assigned todos + observational notes flow through silently — no recap mention. Empty action-item set → skip recap entirely.
  - **Confirmation can happen mid-call OR in the recap.** When Audri advertises a capability mid-call ("want me to research X?") and the user explicitly says yes, that counts as a confirmed agent-task — fan-out's commitment extraction picks it up post-call as it would any commitment. The end-of-call recap **does not need to re-surface mid-call-confirmed items** for confirmation; resurfacing them is friction. Recap may still mention them briefly for transparency if the recap list is otherwise short, OR if the user explicitly asks ("what did I sign up for?"). Users can still drop mid-call-confirmed items by saying so in any later turn (transcript turn → `dropped_turn_ids` at commit).
  - **Amend = conversational, not structured** — user corrects via natural language; transcript carries the latest version of each commitment; fan-out's commitment extraction picks up the latest. No special UI / no edit-form at MVP.
  - **Dropped-call handling**: when `end_reason ∈ {silence_timeout, network_drop, app_backgrounded}` AND in-call confirmation didn't complete, server runs a lightweight Flash pass over the transcript to extract candidate action-items + surfaces them as in-app "deferred review" notifications. User confirms/drops each → triggers delayed ingestion.
  - **User-cancelled calls**: `end_reason='user_cancelled'` persists transcript with `cancelled: true` (new column on `call_transcripts`) but **skips ingestion entirely** — no fan-out, no agent_tasks, no wiki writes.
  - **Audri's recap text is not a claim source** (per `specs/fan-out-prompt.md` §4.1) — the recap is for confirmation UX only.
  - **New schema additions for MVP**:
    - `call_transcripts.dropped_turn_ids: text[]` — turn IDs the user explicitly dropped during recap; fan-out skips these for commitment extraction.
    - `call_transcripts.cancelled: bool` (default false) — marks user-cancelled calls; ingestion skip.
    - `call_transcripts.summary: text` (nullable) — short summary for recent-activity preload (Layer 6) + UI listing; AI-generated post-call.
    - `call_transcripts.session_id: text unique` — idempotency key for `/calls/:session_id/end`.
  - **Audio retention: transcript only at MVP. Raw audio NOT persisted.** Flagged for V1+ reconsideration in `backlog.md` — triggers: transcript quality issues requiring source review, user-requested call replay, compliance/audit need.
  - **Agent-turn ingestion exclusion** is per `specs/fan-out-prompt.md` §4.1 (Audri's speech is not a claim source). Flagged for V1+ reconsideration in `backlog.md` — current invariant prevents closed-loop hallucination but may be over-strict if Audri's clarifying restatements ("so you mean X?") would be useful claim sources after user confirmation.
- ⏺️ **Contextual-call preload**
  - When starting from a wiki page or other artifact, how that context is injected.
- ⏺️ **Transcript format spec**
  - Turn-by-turn JSON vs. plain text; speaker tags; timestamps.
- ⏺️ **Mid-call tool set beyond `search_graph`**
  - Web search? Fetch URL? Calendar peek? Decide MVP tool set.
- ⏺️ **Call resumption**
  - If the network drops mid-call, what's the resume behavior?
- ⏺️ **Audio retention**
  - Keep raw audio, or transcript only?
- ⏺️ **Barge-in (user-interruption) UX in Gemini Live** — pre-MVP debug
  - Currently a debug task in the sandbox client. User must be able to interrupt Audri mid-utterance (cuts off audio, pivots to listening). Critical for voice-first UX — without it, brevity discipline matters more; with it, longer responses are tolerable since users can just interrupt.
  - Required for MVP. Affects how strict Chunk 2 §E2 brevity rules need to be.

---

## 9. Interaction modes

Voice-first, but text-capable. Users can't always talk (meetings, shared spaces, noisy environments); the system degrades gracefully to text without switching pipelines.

- ⏺️ **Text mode (chat)** — first-class alongside Call
  - User can send text messages and receive text replies. Same agent scaffolding as Call (same persona, same preloaded context), different I/O plumbing. Transcript shape is turn-tagged just like a call transcript — the fan-out pipeline is mode-agnostic.
  - Triggering: toggle mid-call to switch voice ↔ text without ending the session? Or separate entry point? Decide before MVP ships if text is included in MVP.
  - MVP scope decision: include in V0 or push to V1? Depends on how much voice-only UX the MVP can stand on before text parity becomes a friction point.
- ⏺️ **Ask mode**
  - Triggering UX; routes through Gemini Live or a lighter request-response path.
  - Contextually aware. Can be kicked off from anywhere in the app and use the user's current context to start the conversation.
- ⏺️ **Note mode**
  - Bypasses dialogue; voice-to-transcript-to-KG. Shares the ingest pipeline with calls.
- ⏺️ **Triggering UX for all modes**
  - Button layout, long-press menu, wake word, text-mode toggle. Deferred until Call mode is solid.

---

## 10. Onboarding

Full SPEC at `specs/onboarding.md`. Covers seed protocol + interview design + resumption handling.

- ✅ **High-level flow drafted**
  - Signup → seed defaults → onboarding interview → home.
- ✅ **Seed set**
  - 20 seeded `wiki_pages` rows: 5 agent-scope (`assistant` root + observations / recurring-themes / preferences-noted / open-questions); 10 user-scope profile (`profile` root + 9 children: goals, values, life-history, health, work, interests, relationships, preferences, psychology); 5 todos (`todos` root + 4 status buckets). Plus 1 `agents` row (default Assistant) + 1 `user_settings` row (with `enabled_plugins: ['research']`, `onboarding_complete: false`). All in one signup transaction; idempotent. Pages start empty (no `wiki_sections` rows); onboarding interview transcript drives fan-out to fill profile sections. Stock `agent_abstract` strings per page until ingestion regenerates. Full details in `specs/onboarding.md`.
- ✅ **`onboarding_complete` behavior (router-related)**
  - `user_settings.onboarding_complete: bool` (default false). **Does NOT gate the home screen** — user can enter the app normally even before onboarding is finished. Instead: at the start of subsequent calls, if `onboarding_complete=false`, the call is offered as a continuation of onboarding ("want to pick up where we left off?"). If user explicitly skips ("no, just talk normally") OR completes onboarding via the "good enough" heuristic, the flag is set true and never re-surfaces. This avoids trapping users in an onboarding gauntlet while still nudging completion organically.
  - **Core plugins pre-enabled at install** — research at MVP. User can immediately invoke research from any post-onboarding call without explicit plugin enablement.
- ✅ **Onboarding interview script/prompt** — **SPEC** at `specs/onboarding.md`
  - Structured-but-conversational. Opens with brief Audri self-intro + opener question ("What brings you to Audri?"). 7 askable profile areas (goals, life-history, health, work, interests, relationships, preferences) + 2 emergent-only areas (values, psychology — never explicitly asked; backfill via natural claim-routing). Slightly proactive capability advertisement tied to stated needs (no upfront menu). Audri adapts depth/transitions based on user. Decision rules locked; prompt-text drafting remains.
- ✅ **Interview progress tracking**
  - In-call only (no DB persistence). Audri maintains working sense of "covered areas" + references conversationally. Post-call: standard ingestion runs against transcript; profile pages become populated. State of onboarding is implicit in profile-content thickness — empty/light = needs more, substantive = done.
- ✅ **"Good enough to leave interview" heuristic**
  - Target call length: ~10 min average. Wraps when ≥1: (a) 4+ of 7 askable profile areas covered substantively (Values + Psychology emergent, don't count), (b) user explicitly signals done, (c) 15-min soft cap reached and user accepts wrap. Resumable later from settings.
- ⏺️ **Trial-artifacts during onboarding** — **deferred to backlog (V1+)**
  - Originally scoped for MVP as a wow-factor moment (mid-call kickoff during onboarding so artifacts await on home screen). Bumped to backlog to keep MVP focused. Onboarding becomes a pure interview at MVP — no mid-call task kickoff anywhere. See `backlog.md`.

---

## 11. Background tasks

Core architecture: **agent-assigned todos drive all background work.** Ingestion creates a todo wiki page + `agent_tasks` row; a CRON scans pending `agent_tasks`, enqueues Graphile jobs on the `agent_tasks` queue; a worker dispatches by `kind` via the plugin registry; handler produces an artifact row (per-kind table) + optionally triggers re-ingestion. See `notes/data-flow-architecture.md` for the universal trigger pattern. Full design lives in `specs/background-loop.md` (TBD — Chunk 2+ of the §11 design).

- ✴️ **Background loop architecture** — **SPEC**
  - Chunk 1 (data model) ✅. Chunk 2 (queue mechanics) ✅ — locked decisions below. Remaining chunks: handler contract (3), lifecycle + failure handling (4), observability (5).
- ✅ **Observability** (Chunk 5)
  - **Structured logging via pino** (NestJS-idiomatic, JSON-structured). Worker + API share config.
  - **Correlation context bound to every worker log line:** `user_id`, `agent_tasks_id`, `kind`, `graphile_job_id`, `retry_count`, `agent_id` (when present), `call_transcript_id` (for ingestion). Handler's `ctx.logger` pre-bound; handler log lines inherit.
  - **Log levels:** `info` for task-lifecycle events, `warn` for retryables, `error` for unrecoverables, `fatal` for worker crashes, `debug` gated by env for dev-only verbosity.
  - **Logged task-lifecycle events (info):** `task_picked_up, handler_started, llm_call_started/succeeded/failed, output_validated, commit_started/succeeded/failed, task_succeeded/failed/cancelled, retry_scheduled, ghost_detected`. Each with correlation context + event-specific fields.
  - **Log aggregation:** Render's built-in for MVP. Migrate to Datadog / Logtail / Axiom / Grafana Loki V1+ when query needs or volume demand it.
  - **No dedicated metrics infra at MVP** — no Prometheus / Grafana / StatsD. All queue + task metrics derivable from ad-hoc SQL over `agent_tasks` + `usage_events` via Supabase Studio. PostHog server-side events become the metrics path V1+ (already in stack for analytics + feature flags).
  - **Sentry (already in §21):** auto-captures `error`-level logs + explicit `captureException` + unhandled rejections. `PermanentError` / `ValidationError` always sent. `RetryableError` only sent after final retry exhausted. Enrichment: `user` context, `tags` (agent_tasks_id, kind, retry_count, graphile_job_id), `breadcrumbs` (last N handler logs), `extra.payload` (redacted).
  - **PII redaction at pino transport layer.** Starts minimal (user prompt content, LLM outputs in error paths, connector payloads); expand as we observe leaks. Over-redaction makes debugging miserable, so erring permissive-then-tighten.
  - **User-facing task status** rendered from `agent_tasks` row state via RxDB observable queries — UI reactively updates as status changes server-side. Notifications on `succeeded`/`failed` terminal transitions (cancel is user-initiated; no notification). Tap → artifact deep link (success) / error + retry button (failure) / status detail (pending/running).
  - **No progress percent ever (or very late).** In-progress bucket on agent-assigned todos gives users enough visibility; a real progress bar requires handler cooperation and ETA math that may never be worth it.
  - **Cost observability backend-only at MVP.** Ad-hoc SQL over `usage_events`. User-facing per-task cost surfaces V1+ alongside pricing/tier model (§17b).
  - **Failure triage at MVP:** Sentry issue view + SQL. Dedicated admin dashboard V1+.
  - **No distributed tracing at MVP.** Correlation IDs in structured logs cover 80% of debugging need. OpenTelemetry + Jaeger/Tempo V1+ only when logs aren't enough.
- ✅ **Handler contract** (Chunk 3)
  - **Handler signature:** `(ctx: HandlerContext) => Promise<HandlerReturn>` where ctx is `{ task, payload, entry, user, agent, systemPrompt, now, llm, kg, connectors?, logger, signal }` and return is `{ output, sources, reingestIntoWiki? }`. `agent` always non-null at MVP (every task runs as a persona). `connectors` present only when `entry.requiredConnectors` is non-empty. Handler has no direct DB write access — backend's commit helper writes `output` + `sources` + updates `agent_tasks` in one transaction (per Chunk 2 C1).
  - **KG access:** handler code uses a typed `kg` read client (`kg.getPage(slug)`, `kg.listPagesByType(type)`, `kg.searchWiki(query)`). Handler's LLM calls get **minimal tool palette**: `search_wiki(query)`, `fetch_page(slug)`, `list_children(slug)`. Kind-specific additions declared via `entry.availableTools: ToolKind[]` (e.g., research adds `search_web`, `fetch_url`). Tools routed through the `llm` client for uniform instrumentation.
  - **Output emission:** single JSON blob at end of handler, validated against `entry.outputSchema` (zod) before commit. No streaming / no partial progress updates at MVP; if UX needs a long-running-task progress indicator later, add `progress_pct` on `agent_tasks`.
  - **Sources as tagged union:** handler returns `sources: HandlerSource[]` with `kind: 'url' | 'wiki_ancestor' | 'research_output' | 'transcript' | 'upload'` discriminator; backend routes to the right `<artifact>_sources` / `<artifact>_ancestors` junction table. **MVP granularity: artifact-level** — all sources attach to the output as a flat list; no per-subunit attribution (defer until an artifact kind has natural subunit IDs and UX needs per-section cites).
  - **Re-ingestion: all kinds default `reingestsIntoWiki: false` at MVP.** No artifact flows back into the wiki at MVP — each plugin's UI module surfaces its own artifacts. Re-ingestion is a V1+ capability; when added, the registry flips individual kinds to `true` (research + briefs likely) with their handlers free to override per-invocation via the `reingestIntoWiki` return field.
  - **Context: `now` frozen at task start** for reproducibility on retry. `user` carries id/tier/timezone. `agent` carries the active persona (id, slug, name, voice, persona_prompt, user_prompt_notes).
  - **Connector access:** typed per-connector methods (`connectors.gmail.createDraft({...})`, `connectors.google_calendar.createEvent({...})`); handler never sees raw OAuth tokens. Defensive runtime check rejects access to non-declared connectors.
  - **Connector write policy (V1+ / deferred):** when connectors land, default posture is drafts may be auto-produced but any external send/create requires user review + approval. Review can happen inside Audri or in the 3rd-party service (user opens their email draft in Gmail to send). Per-kind specifics deferred — revisit with the connector integration pass.
  - **Error handling:** handler throws exceptions; worker dispatches on error class. `RetryableError` (rate limit / timeout / transient network) → retry per registry `maxAttempts`; `PermanentError` / `ValidationError` → immediate fail. Unknown errors → conservatively treated as retryable. Handler itself never retries LLM calls — throws and lets the worker re-run the whole handler (matches transactional-commit model).
  - **Conservative retry posture for MVP** — minimize retries, surface failures. Low `maxAttempts` ceilings in registry (lean 1–2 total attempts — original + at most one retry). Prefer visible failures + user re-run over silent auto-recovery. Full retry-policy detail lives in Chunk 4.
  - **LLM call conventions:** `llm` client pre-configured per kind at worker startup — Gemini explicit cache registered for the static system prompt (one cache object per kind, refreshed at TTL); model tier, temperature, token budget from registry. Handler calls `llm.generateContent(...)` without touching cache setup. Token counting instrumented inside `llm` — emits `usage_events` rows with `agent_tasks_id` automatically.
- ✅ **Queue mechanics** (Chunk 2)
  - **Job enqueue pattern:** Atomic — application code creates the `agent_tasks` row AND calls `graphile_worker.add_job()` in the same transaction. No orphaned rows. Graphile job payload holds only `{ agent_tasks_id }` — single source of truth in `agent_tasks`.
  - **Scheduled + retry pickup via Graphile recurring job (CRON scanner):** every 30s, selects `status='pending' AND scheduled_for <= now() AND graphile_job_id IS NULL` (plus retry-eligible rows), orders by `priority DESC, scheduled_for ASC`, uses `SELECT ... FOR UPDATE SKIP LOCKED`, batches up to 100 per tick. No `pg_cron` dependency.
  - **Ingestion per-user serialization** via Graphile `queue_name = 'ingestion-${user_id}'`. FIFO within user, parallel across users. Solves the ingestion-race concurrency concern. `job_key` deliberately not used (its default is deduplication, not serialization — wrong semantics).
  - **`agent_tasks` queue:** single shared queue (`queue_name='agent_tasks'`) for MVP, all kinds pooled. Per-kind concurrency caps (`agent_tasks-${kind}`) reserved as a future refactor if a kind needs throttling.
  - **Worker pool:** 4–8 concurrent jobs total; tune based on observed load + Gemini rate limit consumption.
  - **Per-user fairness on `agent_tasks`: deferred.** Graphile priority field + natural tier-gate limits suffice for MVP. Revisit if one user's queue pressure starves others.
  - **Idempotency via end-of-handler transactional commit.** Handler makes LLM calls (outside any transaction; retries re-do them), validates output, opens a single Postgres transaction that writes artifact row + source junctions + `agent_tasks.status='succeeded'`, commits. Retries are correctness-safe; LLM cost duplicates on retry (acceptable MVP cost). Checkpointing deferred unless retry LLM cost becomes material.
  - **Timeout enforcement:** defense in depth — Graphile Worker's built-in job timeout (from `registry[kind].timeoutMs`) + handler wraps LLM calls in `Promise.race` with per-call timeouts.
  - **Worker process:** separate Render background-worker service. One codebase, two entry points (`apps/server` API, `apps/worker` Graphile runner). Crashes don't cascade; independent scaling.
- ✅ **`agent_tasks` as queue substrate** (see §3)
  - Locked: agent-assigned todos create both a wiki page (user-facing, graph-citizen) and an `agent_tasks` row (queue-processable, workflow-aware), linked by FK. User-assigned todos ("buy milk") have only the wiki page. Graphile Worker on `agent_tasks` queue is the runtime; the CRON scanner translates pending `agent_tasks` rows into Graphile jobs.
- ✅ **Plugin kind registry** (module shape locked — SPEC for implementation remains)
  - Single TypeScript module exporting a `pluginRegistry` object literal mapping each queue-runnable `kind` to its entry. One-source-of-truth; read by worker dispatcher, fan-out prompt, call-agent prompt composer, ingestion validator, output validator, artifact writer, tier-gate enforcer.
  - **Split: public manifest + server-only registry.** Client gets a derived `pluginRegistryLite = pluginRegistry.map(pick(liteProperties))` with public fields only (kind, capability description, artifact kind, connector deps, enabled-on-tier gates). Server has the full entries including handler module + zod schemas + prompt paths.
  - Wiki and Todos are NOT in `pluginRegistry` — they aren't queue-runnable and don't produce artifacts. They're handled as client-side built-in routes that query existing tables directly (Wiki over `wiki_pages` + `wiki_sections`; Todos over `wiki_pages WHERE type='todo'` joined with `agent_tasks`). See `tradeoffs.md` — "UI module registry (considered, YAGNI'd)" for the design space we explored.
  - **Entry shape (per `kind`):**
    - `kind: string` (type-locked via `as const` literal)
    - `prompt: string` (path to static system-prompt file; cacheable; runtime interpolation is the handler's job — no builder functions for MVP)
    - `handler: (ctx) => Promise<output>` (worker logic)
    - `inputPayloadSchema: ZodSchema` (validates `agent_tasks.payload`)
    - `outputSchema: ZodSchema` (validates LLM/handler output before commit)
    - `capabilityDescription: string` (free-form; composed into call-agent and fan-out prompts)
    - `requiredConnectors: ConnectorKind[]`
    - `artifactKind: string | null` (which artifact table the result lands in; null for pure side-effect kinds)
    - `reingestsIntoWiki: bool` (after commit, enqueue follow-on ingestion with artifact as source)
    - `immutable: bool` (artifact edit semantics — information-only; backend enforces by not exposing edit endpoints)
    - `modelTier: 'flash' | 'pro'`
    - `tokenBudget: number` (per-invocation ceiling)
    - `timeoutMs: number`
    - `maxAttempts: number` (retry ceiling — NOT per `agent_tasks` row)
    - `defaultPriority: number`
  - **Static for MVP + all V1; DB-backed / runtime-installable plugins deferred until bundle size or install flexibility becomes a real issue.**
  - **Tier-gate integration deferred until §17b subscription model lands.** Registry stays tier-agnostic; tier-gate enforcer is a separate module that references the registry. Revisit when pricing is defined.
- ✅ **Capability-availability levels** (new — called out for the call-agent prompt composition)
  - Four levels determine what capabilities are surfaced where:
    1. **System** — every kind in the registry.
    2. **Tier-granted** — kinds the user's subscription tier allows.
    3. **User-enabled** — of those, kinds the user has explicitly enabled.
    4. **Connector-ready** — of those, kinds whose `requiredConnectors` are currently connected + valid.
  - **Backend** (task dispatch validator) checks all four, rejecting at the highest unmet level with a specific error.
  - **Call-agent system prompt** composes capability descriptions from level 4 only — Audri never advertises what the user can't use.
  - **Fan-out prompt** (Pro) composes capability descriptions from level 3 (user-enabled) — commitment-to-todo routing should route commitments into kinds the user has enabled, even if a required connector isn't currently connected (surfacing a "connect your account" prompt to the user is more useful than silently dropping the commitment).
- ✅ **Task kinds for MVP** (locked)
  - **V0 (MVP): `research` only.** All other kinds (podcast, email_draft, calendar_event, brief, daily_summary, evening_summary, …) are V1+.
  - Registry entry for `research` is the reference implementation; other kinds pattern-match on it.
- ✴️ **Per-task prompt design** — **SPEC** (one per kind)
  - **MVP: research only** — SPEC at `specs/research-task-prompt.md` (decision rules + I/O contract + handler outline locked; prompt-text drafting remains).
  - V1+: podcast, email, calendar, brief — each gets its own SPEC when its plugin lands.
- ✅ **Task output format** (locked with artifacts pivot)
  - Handler emits a semantic JSON output validated against `outputSchema`. Backend writes to the artifact table named by `artifactKind`, attaches source rows (`<artifact>_sources`, `<artifact>_ancestors` etc.), updates `agent_tasks.result_artifact_kind + result_artifact_id + status='succeeded'`, moves the todo page from `todos/todo` → `todos/done` (reparent), writes a `wiki_log` `task` entry.
  - If `reingestsIntoWiki=true`, enqueue a follow-on ingestion job with the artifact as source — wiki sections cite via `wiki_section_<artifactKind>` junction.
- ⏺️ **Task failure surfacing**
  - How errors appear to the user (notifications? call-history entry?). `agent_tasks.status='failed'` + `last_error` is the source; rendering is UX. To be spec'd in Chunk 5 (observability).
- ⏺️ **Cancellation / amendment mid-run**
  - Can a user stop a running research task? `agent_tasks.status='cancelled'` + handler cooperation. To be spec'd in Chunk 4 (lifecycle).
- ⏺️ **Cost observability per task**
  - Per-task token / cost attribution via `usage_events.agent_tasks_id`. See §17b.
- ⏺️ **User-assigned todo reminder firing** (V1+)
  - User-assigned todos with `due_at` fire as notifications. Not queue-executed (no agent action); surfaced via a notification scheduler. Depends on §12 scheduled-task infra.

---

## 12. Scheduled & event-driven content

- ⏺️ **Scheduled / recurring tasks** — **SPEC**
  - Configuration surface (conversational vs. settings), schedule storage, timezone handling. (architecture.md §Open questions)
- ⏺️ **Cron / next-run evaluation engine**
  - Lean on pg_cron, run inside NestJS, or use a dedicated scheduler?
- ⏺️ **Pause/resume/edit UX**
  - How users manage their schedules.
- ⏺️ **Event-driven content (deferred long-term)**
  - RSS, topic-change detection, release alerts. Explicitly out of MVP. (features.md)

---

## 13. Activity stream, notifications, recommendations

- ⏺️ **Notifications feed data model**
  - See §3.
- ✅ **In-app notifications only for MVP; push notifications deferred to V1+**
  - MVP notifications surface via the in-app activity stream + terminal-transition toasts when the user is in the app. No push infrastructure (APNs/FCM permissions flow, Expo Push setup, per-platform certificate management). Users who aren't in the app will see the notification next time they open it.
- ⏺️ **Push infrastructure** (V1+)
  - Expo Push vs. native APNs/FCM. Flagged as V1+ work in `backlog.md`. Depends on notifications feed data model landing first + per-user delivery-channel preferences.
- ⏺️ **Notifications design** — **SPEC**
  - Grouping, snooze, dismiss, deferred-confirm (for dropped calls). (architecture.md §Open questions)
- ⏺️ **Proactive-recommendation detection**
  - Scheduling proposals, split proposals, follow-up proposals, merge proposals. Each needs a trigger + prompt. (features.md §Proactive recommendations)
- ⏺️ **Periodic usage + interest review**
  - Scheduled background pass that reviews usage patterns, expressed interests, stated goals, and preference accretion to surface proactive recommendations ("you've been talking about X a lot — want to set up a weekly research on it?", "you haven't touched your health profile in a while — want to check in?"). Own prompt + own kind in the plugin registry. Cadence: weekly lean; gated by user preference.
- ⏺️ **Delivery-channel preferences**
  - Global vs. per-task-type vs. per-schedule. Storage + editing UX. (features.md §Adaptive delivery channels)

---

## 14. Deep connectivity (cross-artifact navigation)

- ✅ **Principle**
  - Every artifact is a graph citizen with provenance + downstream consumers.
- ✅ **Reverse-lookup implementation**
  - Two-JOIN query via section-level junction tables (§3, §5). Materialized view optional for high-volume users; live query fine at MVP scale.
- ⏺️ **UI affordances**
  - Per-artifact "related" panel shape.

---

## 15. Connectors (3rd-party integrations)

Elevated to first-class citizens alongside Wiki / Todos / Plugins / Agents. Each connector bears durable per-user state (OAuth tokens, refresh cycles, rate limits, granted scopes) and exposes one or more *capabilities* that plugins consume. See `notes/data-flow-architecture.md`.

- ⏺️ **`connectors` table** — **SPEC**
  - Proposed shape: id, user_id, kind (enum: google_calendar, google_email, linear, google_drive, …), status (connected, expired, revoked), granted_scopes (text[]), access_token (encrypted), refresh_token (encrypted), expires_at, last_refreshed_at, provider_account_email (for display), created_at.
- ⏺️ **Capability registry**
  - Module mapping `connector_kind → capability list`. Plugins declare required capabilities; enabling a plugin surfaces "connect your Google account" prompts when capabilities are missing.
- ⏺️ **Provider priorities**
  - Google first for calendar/email/contacts — confirm?
- ⏺️ **OAuth flow**
  - NestJS-side token storage, refresh, revocation. Token refresh as a scheduled background task.
- ⏺️ **Calendar connector**
  - How events surface in the KG (pages? external refs? both?). Scope read vs. write.
- ⏺️ **Email connector**
  - Scope: draft-only for MVP, or read inbox too?
- ⏺️ **Contacts connector**
  - How imported contacts map onto `person` pages + aliases.
- ⏺️ **Token / secret storage**
  - Supabase Vault vs. server env vs. per-user encrypted. Lean Vault.
- ⏺️ **Connector UX**
  - Settings screen listing available + connected connectors; per-connector detail view showing granted scopes, connected account, disconnect action. Receipt of connector writes surfaced in activity stream.

---

## 15b. Agents (custom personas)

First-class concept. User has one or more agents — personas with distinct names, voices, persona prompts, and private wikis. MVP ships with a single seeded `Assistant`; custom agents land V1+ with no schema migration. See `specs/agents-and-scope.md` for the full design.

- ✅ **Multi-agent data model** (design now, operate at N=1)
  - `agents` table + `wiki_pages.agent_id` column. Exactly one row per user at MVP. See §3.
- ✅ **Per-agent private wiki**
  - Each agent owns an agent-scope subtree rooted at its `root_page_id`. Strict per-agent partitioning via RLS.
- ✅ **Shared user wiki across all agents**
  - All agents (current + future) read the same user-scope wiki. Only agent-scope is partitioned.
- ✅ **Persona loading at session start**
  - See §8.
- ✅ **Separate agent-scope ingestion pass** — **SPEC**
  - Flash-driven, isolated from user-scope Pro fan-out. See §6 and `specs/agents-and-scope.md`.
- ⏺️ **Persona editing UX** (V1+ for non-default, MVP for Assistant customization)
  - Rename agent, change voice, append `user_prompt_notes`. Built-in Assistant can be customized from day one; custom-agent creation is V1+.
- ⏺️ **Voice selection mechanism**
  - Gemini Live's default voice for MVP; ElevenLabs or richer voice variety deferred to V1+. Voice picker UI is V1+.
- ⏺️ **Default Assistant protection**
  - Built-in Assistant cannot be tombstoned (app-level check). Custom agents are freely tombstoned V1+.
- ⏺️ **Agent deletion semantics** (V1+)
  - Tombstone the `agents` row + cascade-tombstone the agent-scope subtree? Or block deletion when the subtree has substantial content? Defer until custom agents ship.
- ⏺️ **Cost attribution per agent**
  - Multi-agent makes "which persona spent how much" a real question. Usage/billing tables should carry `agent_id` from day one so backfill isn't needed. See §17b.
- ⏺️ **Agent-creation onboarding** (V1+)
  - Does a new custom agent run a truncated interview to seed its private wiki? Or start empty and accrete observations? Defer.
- ⏺️ **Mid-session agent switching** (V1+ / maybe never)
  - "Actually, talk to the Health Coach about this" mid-call. Probably forced call-end + new call, not a runtime switch. UX call.

---

## 15c. Plugins (installed capabilities)

A plugin is a queue-runnable capability that produces an artifact: `pluginRegistry` entry (kind + prompt + handler + schemas + connector deps) + dedicated per-kind artifact table (+ Storage bucket for binaries) + dedicated UI module rendering that table. Research, Podcasts, Gmail, Calendar, Briefs are all plugins.

**Wiki and Todos are NOT plugins** — they're core built-in UI surfaces that the client app renders from existing tables (Wiki over `wiki_pages` + `wiki_sections`; Todos over `wiki_pages WHERE type='todo'` joined with `agent_tasks`). They have no kind, no handler, no artifact table. They're always present, can't be uninstalled, and don't need registry infrastructure — data-fetching + filtering logic lives client-side. See `tradeoffs.md` for the UI-module-registry design space we considered and deferred.

Adding a new plugin = registry entry + artifact table migration + UI module + call-agent awareness. No ingestion / CRON / dispatcher changes required. See `notes/data-flow-architecture.md`.

- ✅ **`pluginRegistry` module** (shape locked — see §11 for full entry-shape spec)
  - Single TS module, one-source-of-truth, split into a full server-only `pluginRegistry` + a derived client-safe `pluginRegistryLite` via `pick(liteProperties)`.
- ✅ **Capability-availability levels** (see §11)
  - Four levels: System / Tier-granted / User-enabled / Connector-ready. Backend enforces all four; call-agent prompt sees level 4 only; fan-out prompt sees level 3.
- ⏺️ **First-party plugins for MVP**
  - **MVP: `research` only.** V1: `podcast`, `email_draft`, `calendar_event`, `brief`.
- ⏺️ **Plugin UI modules** — each plugin ships a dedicated UI surface
  - **Research** (MVP): library of research outputs + detail view + spawn-research affordance.
  - **Podcasts** (V1): library + player.
  - **Gmail** (V1): drafts list + review + send.
  - **Calendar** (V1): proposed events + confirm/edit.
  - **Briefs** (V1): daily/weekly brief library + detail view.
  - Each module queries its own artifact table and renders kind-specific affordances without cross-module coupling.
- ⏺️ **Core (non-plugin) UI modules**
  - **Wiki**: knowledge graph browse + edit over all `wiki_pages` + `wiki_sections`. Always-on.
  - **Todos**: task-management UX over `wiki_pages WHERE type='todo'` joined with `agent_tasks`. Users create, check off, reassign, set due dates, nest sub-tasks via standard wiki writes. Always-on.
  - These aren't plugins; they're core app surfaces backed by existing tables. No registry entries.
- ⏺️ **Plugin installation / enablement UX**
  - Per-plugin enable toggle; connector-required prompts when a user tries to enable a plugin whose `requiredConnectors` aren't connected.
- ⏺️ **Third-party plugins** (V1++ at earliest)
  - User-authored or marketplace plugins. Runtime-installable plugins deferred until app bundle size or install flexibility becomes a concrete constraint. Registry shape leaves the door open; implementation is out of scope for MVP + all of V1.
- ⏺️ **Skills** (V1, P0 in `backlog.md`)
  - Context-aware capability suggestions surfaced by the agent — pre-defined prompt patterns that compose existing primitives (wiki writes via fan-out, plugin invocations, inline generation). Solves the prompting-skill barrier. Lives in a parallel `skillRegistry` alongside `pluginRegistry`; composes into Layer 4 of the call-agent prompt as trigger-relevance-filtered advertisements. Lightweight Skills compose into existing paths (no new infrastructure); heavier Skills graduate to full plugins. Naming follows Anthropic's existing mental model. **Out of MVP scope** to keep the build focused; full design when V1 starts. See `backlog.md`.

---

## 17b. Usage tracking & billing

Cross-cutting concern. Every call (voice or text), every ingestion pass, every background task produces token consumption + artifact creation; some also count against capacity-based quotas (uploads, disk). Usage tracking is load-bearing for (a) tier-gating, (b) user-facing cost transparency, (c) per-service cost attribution for product decisions.

- ✅ **Usage events table** — schema locked
  - Shape: `id, user_id, agent_id (nullable), agent_tasks_id (nullable), event_kind (text — see kinds below), input_tokens, output_tokens, cached_tokens, model (text), cost_cents (computed at write time from per-model rate table), artifact_kind (nullable), artifact_id (nullable), call_transcript_id (nullable), created_at`.
  - **`event_kind` enum (MVP):** `'call_live'`, `'ingestion_prefilter'` (the candidate-retrieval pass), `'ingestion'` (the main fan-out pass), `'agent_scope_ingestion'`, `'plugin_research'`, `'tool_search_google'` (if migrated from Live grounding to custom tool — V1+), `'tool_search_wiki'` (DB-only, $0 cost; emitted for analytics, not billing), `'tool_fetch_page'` (same).
  - Event-kind names deliberately decoupled from inference-provider naming (no `flash` / `pro` in column values) so swapping providers later doesn't require a migration.
  - **Indexes:** `(user_id, created_at DESC)`, `(user_id, event_kind, created_at DESC)`, `(agent_tasks_id)`.
  - **Cost computation:** server maintains a per-model rate table in code (input/output/cached prices per million tokens); `cost_cents` computed at insert time from `(model, *_tokens)` values. Updated when Gemini changes pricing.
  - **No retention policy at MVP** — events grow with usage but are small rows. Nightly rollup table (`usage_daily`) deferred to V1+ when dashboard queries warrant it.
- ⏺️ **Rollup / summarization strategy**
  - Raw events grow fast. Nightly rollup to `usage_daily` (user_id, day, event_kind, totals) for dashboard queries. Raw events retained N days or archived.
- ⏺️ **Tier gating**
  - Subscription tiers (free, pro, higher) define caps on:
    - Call minutes per month (voice)
    - Text messages per month (or bundle with calls)
    - Artifacts per month (podcasts, research, emails, calendar events — each may have its own cap or a pooled cap)
    - Wiki pages total (storage/complexity gate)
    - Uploaded sources per month + total disk
    - Custom agents (V1+): max count per tier
    - Connectors: max concurrent connected
  - Gate enforcement: soft (warn, allow) vs. hard (block). Per-cap decision.
  - **Tier-gate integration with `agent_tasks` deferred until the subscription model (below) is finalized.** Enforcement point is clear (wraps `enqueueAgentTask()`), but cap structure depends on decisions not yet made. Bundle with the pricing-model pass.
- ⏺️ **Pricing model** — **SPEC**
  - Tiered subscription with gated usage, OR pay-as-you-go per-token/per-artifact/per-source, OR hybrid (included monthly allowances + overage billing). Decision.
- ⏺️ **Per-service cost transparency**
  - In-app "where my tokens went" view: conversational (Live + ingestion), per-plugin breakdown, per-agent breakdown. Surfaces `usage_events` rolled up by `event_kind` + optional `agent_id`.
- ⏺️ **Billing provider**
  - Stripe likely; decision not urgent until we're close to monetization. MVP may ship free-tier-only while the data is accumulating.
- ⏺️ **Quota-enforcement integration points**
  - Where the caps are checked: call start (minutes cap), ingestion (token budget), plugin dispatch (artifact cap), upload endpoint (disk + count cap), agent creation (agent cap).
- ⏺️ **Cost alarms** (product + per-user)
  - Already in §17 open items; recapped here for visibility.

---

## 16. Prompts to write (SPEC set)

Centralized list — each prompt gets its own spec doc.

- ✅ **Call-agent system prompt** — **SPEC** done; prompt-text drafting at code time
  - See §8 (full design across 5 chunks).
- ✅ **Onboarding interview prompt** — **SPEC** done at `specs/onboarding.md`; prompt-text drafting at code time
  - See §10.
- ✅ **KG parsing / fan-out prompt** — **SPEC** done at `specs/fan-out-prompt.md`; prompt-text drafting at code time
  - See §6.
- ⏺️ **Noteworthiness classifier prompt**
  - Resolved as inlined: per-claim noteworthiness lives in Pro fan-out (`specs/fan-out-prompt.md` §4.2). Transcript-level noteworthiness is the implicit gate from Flash retrieval (`specs/flash-retrieval-prompt.md` §4.5).
- ✴️ **Flash candidate-retrieval prompt** — **SPEC** in progress
  - See `specs/flash-retrieval-prompt.md`. Decision rules locked; remaining: prompt text, worked examples, evals.
- ✅ **Entity-disambiguation prompt** — resolved as inlined into Pro fan-out
  - Per `specs/fan-out-prompt.md` §4.3, routing rule 2 ("Existing-candidate match") handles disambiguation inline using the candidate set's `agent_abstract`s. No separate prompt.
- ⏺️ **Page-abstract regeneration prompt** (inlined with fan-out for MVP)
  - Pro regenerates `agent_abstract` + `abstract` alongside section writes — no separate pass in MVP. A dedicated prompt + dedicated Flash pass becomes relevant only if abstract quality drifts or fan-out cost demands offloading. See §4, §17.
- ✅ **Research task prompt** — **SPEC** at `specs/research-task-prompt.md`; prompt-text drafting at code time
  - Decision rules + handler I/O + output schema locked.
- ⏺️ **Podcast-script task prompt**
  - See §11.
- ⏺️ **Email-drafting task prompt**
  - See §11.
- ⏺️ **Calendar-event task prompt**
  - See §11.
- ⏺️ **Daily/evening brief task prompt**
  - See §11.
- ⏺️ **Linting / healthcheck prompts**
  - See §7.
- ⏺️ **Proactive-recommendation prompts**
  - One per recommendation kind. See §13.

---

## 17. Cost & inference strategy

- ✅ **Inference-cost control for page edits — section-scoped writes**
  - **Resolved via the sectioned data model (§3).** Pro emits targeted section keep/update/create/tombstone operations rather than full-page rewrites. Unchanged sections cost ~36 chars (uuid only) in the output; only the changed section content is re-emitted. Turns update cost from O(page size) to O(changed section size). Page-splitting at a token threshold (proactive recommendation, see features.md) remains open but is a UX-level nudge rather than a cost-control requirement now.
- ✅ **Prompt-caching strategy**
  - Gemini explicit caching for fan-out main prompt, call-agent scaffolding, research-task scaffolding. Implicit caching handles smaller/variable prompts. See §2 Server for details.
- ✅ **Model tiering**
  - Gemini Flash for candidate retrieval (stage 1 of fan-out) and other lightweight classifiers. Gemini Pro for fan-out main (stages 2–7) + research. Gemini Live for in-call agent. Abstract regeneration inlined with Pro for MVP. See §2 Server.
- ⏺️ **Token budgets per pipeline**
  - Call preload, fan-out per transcript, research task, brief task. Instrumented + alertable.
- ⏺️ **Per-user cost tracking**
  - Persisted per call / per task so we can surface or gate.
- ⏺️ **Batch API usage**
  - For non-latency-critical tasks (overnight briefs, bulk reprocessing).
- ⏺️ **Regeneration debouncing**
  - Summary + index regen triggered on write but coalesced.
- ⏺️ **Embeddings / search-result caching**
  - If §18 adopts semantic search.
- ⏺️ **Cost alarms**
  - Per-user and per-system thresholds.

---

## 18. Search

- ⏺️ **`search_graph` implementation**
  - Postgres full-text first; upgrade to pgvector when. (architecture.md §Open questions)
- ⏺️ **Embedding pipeline**
  - If/when pgvector lands: model choice, when embeddings are computed, how they stay fresh on edit.
- ⏺️ **Ranking**
  - Blend of FTS + recency + relevance.

---

## 19. UX surfaces

- ⏺️ **Wiki browse UI**
  - Virtual folders by `type` (People, Concepts, Projects, Sources, Notes, Research, Profile). Hierarchy tree view within each. Search, filter by tag/type.
- ⏺️ **CRUD UI**
  - Create, tombstone, edit, merge (entity disambiguation), bulk ops, undo stack. Includes an explicit "New Project" affordance (top-level `project` page) and a "Move under…" action for reparenting.
- ⏺️ **Project pinning**
  - User can pin a `project` page as "active"; feeds the preload-prioritization signal (§8). Storage mechanism TBD — boolean column vs. derived from user activity vs. dedicated pins table.
- ⏺️ **WYSIWYG editor choice**
  - Lexical, TipTap, ProseMirror, or custom markdown editor.
- ⏺️ **Graph view**
  - Visualization library, default filters, interactions. (architecture.md §Open questions)
- ⏺️ **Call-history UI**
  - Listing, filtering, linking back to spawned artifacts.
- ⏺️ **Activity-stream UI**
  - Mixed-type feed with grouping + snooze.
- ⏺️ **Notifications UI**
  - In-app screen + push payload shape.
- ⏺️ **Phone FAB ubiquity**
  - Across every screen. (features.md §Start a call from anywhere)
- ⏺️ **Contextual-call initialization**
  - Passing the current page context into call start.
- ⏺️ **Plugin launcher UI**
  - Already prototyped — confirm MVP role.

---

## 20. Auth, security, privacy

- ✅ **Auth provider**
  - Supabase Auth for user accounts (implied by stack).
- ✅ **Auth methods for MVP**
  - **Apple + Google sign-in only.** No email/password. Zero password-recovery surface; mobile-first; strongest trust signals.
- ⏺️ **Account deletion flow**
  - Tombstone vs. hard-delete of all user data.
- ⏺️ **Export**
  - "Download as git repo / zip of markdown" portability path. (architecture.md §Open questions)
- ⏺️ **Agent-scope access audit**
  - Endpoint review + test suite. Already listed in §3.
- ⏺️ **Cross-agent leakage tests** (new — multi-agent partitioning)
  - Agent-scope read with wrong `agent_id` → empty. Agent-scope read missing `agent_id` filter → empty (not "all agents"). User-scope writes cannot fabricate `agent_id` or `scope='agent'`. Persona-prompt fields never appear in client responses. See `specs/agents-and-scope.md` §Privacy invariants.
- ⏺️ **Secret management**
  - Server env vars, Supabase Vault for per-user tokens.
- ⏺️ **Rate limiting**
  - Per-user call starts, per-user task triggers.
- ⏺️ **Abuse / quota ceilings**
  - To prevent runaway inference costs.

---

## 21. Observability, testing, DevEx

- ⏺️ **Logging**
  - Structured logs on both client and server; correlation IDs across call → transcript → fan-out → task.
- ⏺️ **Tracing / metrics**
  - OpenTelemetry or Supabase-native. Prompt-cost metrics, fan-out latency, queue depth.
- ✅ **Error reporting**
  - **Sentry** on client and server. (See §2 Dev tooling.)
- ⏺️ **Unit tests**
  - For fan-out classification & routing.
- ⏺️ **Integration tests**
  - Against a real Postgres — no DB mocks.
- ⏺️ **LLM output evals**
  - For each prompt (noteworthiness, routing, task prompts).
- ⏺️ **RLS / agent-scope leakage tests**
  - Part of the security suite.
- ⏺️ **E2E tests for Call mode**
  - Once the stack is wired.
- ⏺️ **CI/CD**
  - GitHub Actions pipeline for typecheck, lint, test, DB-migration check.
- ✅ **DB migrations**
  - **drizzle-kit**. (See §2 Dev tooling.)
- ⏺️ **Seed data for local dev**
  - Deterministic fixtures to boot against.
- ✅ **Feature-flag / kill-switch mechanism**
  - **PostHog** feature flags. (See §2 Dev tooling.)

---

## 22. Cross-cutting principles to enforce in code

- ✅ **Activity-stream coverage**
  - Every feature that produces work adds to the activity stream.
- ✅ **Graph citizenship**
  - Every new artifact knows its provenance + downstream consumers.
- ✅ **Manual override**
  - Every automation has a manual override.
- ✅ **Filable outputs**
  - Every generated output is filable into the wiki.
- ⏺️ **Structural enforcement**
  - Lint/check these principles — code-review checklist item or architectural fitness test.

---

## 23. Sequencing — what unblocks what

Use this to order the spec-writing passes. Items listed here are the critical path; everything else can be worked in parallel.

1. ✅ **§1 MVP feature cut**
   - V0: Call mode, transcript ingest, wiki browse/edit, research. V1: podcasts + scheduling. Rest deferred.
2. ✅ **§4 profile sub-type handling**
   - Single `profile` type, hierarchy-organized.
3. ✅ **§4 hierarchy semantics**
   - No max depth, app-level cycle check, block tombstone on non-tombstoned children, walk-up slug rule with numeric fallback, filesystem invariant at DB layer.
4. ✅ **§4 Ephemeral vs evergreen content on a page**
   - Timeline / Evergreen heuristic: pages start Evergreen, split only on contradiction, Timeline newest-first with Current/Past annotations. Uniform across page types.
5. ⏺️ **§6 fan-out pipeline SPEC**
   - Gates KG parsing prompt, noteworthiness classifier prompt, §7 lint design.
6. ⏺️ **§11 background-loop architecture SPEC**
   - Gates research-task implementation and §12 scheduler (V1).
7. ⏺️ **§17 cost strategy**
   - Interleave with §6 and §11 since it dictates model tiering and caching design.
8. ⏺️ **§16 prompt specs**
   - Written after their owning systems land.
9. ⏺️ **§8 preloaded-slice SPEC + call-agent prompt**
   - Can proceed in parallel with §6 since call-mode writes are still disallowed; only reads the KG.
10. ✅ **§3 artifact-source decision**
    - Resolved: per-entity junction tables, keyed at section granularity (`wiki_section_transcripts`, `wiki_section_urls`, `wiki_section_ancestors`, `wiki_section_uploads` V1).
11. ✅ **§3 / §17 sectioned pages**
    - Resolved: `wiki_pages` split into `wiki_pages` (metadata + `agent_abstract` + `abstract`) + `wiki_sections` (editable content, h2-granularity). Pro writes at section granularity; unchanged sections cost ~36 chars in output. Resolves §17 inference-cost problem. Timeline becomes a named section (`title='Timeline'`), not a page-level split.
12. ✅ **Multi-agent data model (design-for-many, operate-at-one)**
    - `agents` table + `wiki_pages.agent_id` + per-agent agent-scope partitioning + persona loading at call start + separate agent-scope ingestion pass. MVP ships with N=1 (`Assistant`); no schema migration at V1+. See `specs/agents-and-scope.md`.
13. ✅ **Unified data-flow architecture**
    - Sources & Conversations → Wiki & Todos → Artifacts & Connectors. Todos are the universal trigger for agent actions; plugins extend via registry. See `notes/data-flow-architecture.md`.
14. ✅ **§8 call-agent prompt + preloaded-slice SPEC** (Chunks 1–5 all ✅)
    - Chunk 1 (session init + prompt structure) ✅: `POST /calls/start` flow, server-composes-client-uses, 7-layer prompt composition (with Recent Activity layer), three caching layers, MVP call-types `generic | onboarding`, fail-fast init errors.
    - Chunk 2 (prompt content) ✅: identity + role scaffolding, hard boundaries with override-resistant framing, ontology primer scope, tool-use policy, voice-first output discipline (no jargon — never "wiki"/"KG" in spoken output), capability advertisement pattern, mid-call task NoGo for generic + onboarding trial-artifact exception, persona-breaking handling.
    - Chunk 3 (preloaded slice) ✅: six components in priority order, activity-derived active-projects at MVP, conservative budget (~7–10k slice / ~13–15k total), onboarding minimal variant, no mid-call refresh, markdown sectional format.
    - Chunk 4 (tool palette) ✅: `search_wiki` + `fetch_page` server-implemented, web grounding via Gemini Live built-in flag (custom abstraction V1+), onboarding-only `queue_trial_artifact`, tool-error handling, latency budgets, schema additions (`agent_tasks.is_trial`, `call_transcripts.tool_calls`).
    - Chunk 5 (transcript + call-end) ✅: turn-tagged JSON transcript format, two-phase call-end with confirmation gating only agent-executed actions, atomic commit + enqueue to `ingestion` queue, conversational amend/drop, dropped-call deferred-review, user-cancelled skip-ingestion, transcript-only audio retention at MVP.
    - SPEC writeup can happen when needed; decisions live authoritatively in `todos.md` + `tradeoffs.md`.
15. ✅ **§11 background-loop + `agent_tasks` + kind-registry SPEC** (Chunks 1–5 all ✅)
    - Chunk 1 (data model): `agent_tasks` shape, plugin registry shape, MVP task kinds (`research` only), no companion tables, ingestion queue separation, capability-availability levels.
    - Chunk 2 (queue mechanics): atomic enqueue + 30s CRON scanner, id-only Graphile payload, per-user `queue_name` for ingestion, shared `agent_tasks` queue, transactional-commit idempotency, separate Render worker service.
    - Chunk 3 (handler contract): handler signature + ctx shape, minimal LLM tool palette + kind-specific extensions, single-JSON output, tagged-union source attribution at artifact granularity, all kinds default `reingestsIntoWiki: false` at MVP, connector-write policy (user review required; specifics deferred to V1+), error classes with conservative retry posture, pre-configured `llm` client with auto-instrumented `usage_events`.
    - Chunk 4 (lifecycle + failure): flat retry backoff w/ jitter, `scheduled_for` reuse for retries, pg_notify+AbortSignal cancellation, `status` terminal transitions mapped to todo bucket reparent, no separate dead-letter table, new `agent_tasks` row per user re-queue, 2-layer timeouts, ghost sweep every 15 min w/ 2hr upper bound, worker entry-check for re-delivery idempotency.
    - Chunk 5 (observability): pino structured logs w/ correlation context, no metrics infra at MVP (ad-hoc SQL + Sentry), PII redaction at pino transport, RxDB-observable status in UI, no progress percent, cost observability backend-only, no distributed tracing. In-app notifications only; push to V1+.
    - SPEC writeup can happen when someone needs to reference the whole thing without stitching together `todos.md` + `tradeoffs.md`. For now the decisions live in those two docs authoritatively.
15. ✅ **Artifacts as separate tables (not `wiki_pages`)**
    - Per-plugin artifact tables (+ Supabase Storage bucket for binaries); text artifacts re-ingest into the wiki via the ingestion pipeline with the artifact as source. Removes `research` from the user-scope wiki type set. Each plugin ships as a first-class UI module (Wiki, Research, Podcasts, Gmail, Calendar, …).
16. ⏺️ **§17b usage-tracking + billing model**
    - `usage_events` schema, tier definitions, gate-enforcement points. Can proceed in parallel with §11 Chunks 2–5.
17. ✅ **§10 onboarding SPEC**
    - At `specs/onboarding.md`. Wiki seeding protocol (19 wiki_pages + 1 agents + 1 user_settings, idempotent transaction) + interview design (structured-but-conversational, 8 profile areas, "good enough" heuristic, resumption from settings).
18. ✅ **§3 data model finalization**
    - Indexes, RLS policies, history retention, tombstone retention, frontmatter convention, alias indexing, conflict resolution, offline behavior, hydration strategy — all locked. Drizzle schema + migrations land at code time.
19. ✅ **§17b `usage_events` schema lock**
    - Schema, event_kind enum, indexes, cost-cents computation, no-rollup-at-MVP all locked.
20. ✅ **Research task SPEC** at `specs/research-task-prompt.md`
    - Plugin registry entry, input/output schemas, handler outline, decision rules.
21. ✅ **Sync `architecture.md` and `features.md` with all resolved decisions**
    - architecture.md rewritten from scratch as current-state document; features.md restructured with MVP / V1+ inline tags.
22. ✅ **`judgement-calls.md` created**
    - Log of decisions made without explicit user confirmation during the autonomous spec-completion phase. Worth reviewing before code starts.
23. ✅ **Mobile-app SPEC** at `specs/mobile-app.md`
    - Project structure (`apps/mobile/`), Expo Router layout, NativeWind theming with Azure default + tokened Liquid Glass variants, Apple+Google auth, four screens (Auth / Onboarding / Home / Call), reusable component primitives, Zustand + RxDB state model, full-screen edge-to-edge content discipline, speaking-orb call-session UI, network-drop UX. Spawned V1+ backlog items for theme switcher, avatar account menu, mic-mute UI, transcript feed.
24. ✅ **Build plans** at `build-phases/` — `mvp.md` shipped 2026-04-29; future phases named by semver (e.g. `0.1.1.md`).
    - 10-slice execution roadmap (slice 0 bootstrap through slice 9 pre-launch hardening). Each slice is a runnable end-to-end demo. Estimates ~50–75 days of focused work. Pre-flight checklist (Supabase / Gemini / EAS / Render / Sentry / PostHog / Apple Dev / Google OAuth) gates slice 0.

---

**See also:**
- `backlog.md` — deferred features, infrastructure, tech debt, sorted by priority + effort + type.
- `judgement-calls.md` — log of decisions made without explicit user confirmation during the autonomous spec-completion phase. Worth reviewing before production coding starts.

---

## 24. Definition of "ready to start production coding"

All of the following are true:

- ✅ **MVP feature cut**
  - Written and agreed.
- ⏺️ **Full data model**
  - Reviewed and migrations drafted.
- ⏺️ **Scopes, types, hierarchy**
  - Decided. (Topics dropped; only profile sub-types + hierarchy semantics remain open.)
- ⏺️ **Fan-out pipeline SPEC**
  - Complete with an eval-harness plan.
- ⏺️ **Call-agent prompt + KG parsing prompt**
  - Written at v0 with a test call / test transcript demonstrating acceptable behavior.
- ⏺️ **Background-loop architecture**
  - Picked queue + a minimal end-to-end demo job.
- ⏺️ **RLS policies + agent-scope leak tests**
  - Drafted.
- ⏺️ **Cost strategy**
  - Names model tiers per pipeline and a token budget per call/task.
- ⏺️ **Dev tooling**
  - Monorepo, local Supabase, migrations, CI wired.
- ✅ **Multi-agent scoping decided** — `specs/agents-and-scope.md`
- ✅ **Agent-scope ingestion pass designed** — `specs/agent-scope-ingestion.md`
- ✅ **Plugins first-class** — registry shape locked in §11; per-kind artifact tables in §3
- ⏺️ **Connectors first-class** — V1+ design pass; MVP doesn't ship connector-dependent plugins
- ✅ **Usage events schema** — locked in §17b
- ⏺️ **Pricing / tier model** — V1+ design (deferred per §17b)
- ✅ **Architecture & features docs synced**
  - architecture.md rewritten + features.md restructured with MVP / V1+ tags (§23 step 21).
- ✅ **Judgement calls log**
  - `judgement-calls.md` captures decisions made without explicit user confirmation during autonomous spec-completion. Review before code phase starts.
