# Constellate — Architecture

Authoritative system-design document. Reflects all decisions locked in `todos.md` + `tradeoffs.md` + per-area specs (`specs/*.md`). Updated 2026-04-25.

For deferred / V1+ work, see `backlog.md`. For decisions made without explicit user confirmation during autonomous spec-completion, see `judgement-calls.md`.

---

## Vision

Constellate is a voice-first, general-purpose AI assistant ("Muse") that builds and maintains a persistent, compounding knowledge base about its user — their interests, work, relationships, goals, and evolving understanding of the world.

The interaction model is conversational: the user talks with Muse via voice calls. Each call enriches a personal knowledge graph, which in turn informs every future conversation. Over time the assistant becomes progressively more useful because it progressively knows more.

---

## Target capabilities

**MVP (V0):**
- Onboarding interview that seeds the knowledge graph
- Voice calls with Muse that draw from + contribute to the KG
- Background research as an agent-executed task
- Wiki browse + edit
- Todos surface (projection over wiki)

**V1 + beyond** (see `backlog.md`):
- Podcasts, email drafting, calendar event creation, briefs (more plugins)
- Custom agent personas (Therapist, Coach, etc.)
- Push notifications + adaptive delivery channels
- Connectors to Google services
- Skills (context-aware capability suggestions)
- Trial artifacts during onboarding (mid-call kickoff)
- Recurring scheduled tasks
- Graph view UI

---

## Core UX principles

### Proactiveness
Muse does things without always asking permission. Absorbs information from conversation, files it into the right place, proposes follow-ups, surfaces relevant context unprompted.

### Transparency
Everything the AI does is visible. What it knows, where from, what it wrote, what it inferred. The wiki is a first-class surface the user browses, reads, and edits.

### Friction proportional to cost of reversal
Cheap-to-reverse actions (wiki edits) happen silently with undo. Expensive actions (launching research, sending email) require explicit confirmation. Resolves most UX confirmation-flow questions.

---

## Data flow architecture

```
Sources & Conversations  →  Wiki & Todos  →  Artifacts & Connectors
        (input)                (memory)         (execution)
```

Every operation in the system fits somewhere on this chain. Bidirectionally navigable — audit trails go upstream (what produced this?), downstream (what did this produce?), laterally (what else is related?). See `notes/data-flow-architecture.md` for the full conceptual model.

### The universal trigger: agent-assigned todos

Every agent-executed action — every artifact, every connector write — is mediated by a **todo of a specific kind**. The todo kind determines which prompt runs to produce the output, whether the output is internal artifact or external connector write, where the receipt is filed, and which registry entry the call-agent references.

Adding a new agent capability = (1) new kind in the plugin registry enum, (2) generative prompt, (3) handler module, (4) artifact table, (5) UI module, (6) make call-agent aware via capability description. No changes to ingestion, CRON dispatcher, or activity stream.

---

## First-class citizens

| Citizen | What it is | Data shape |
|---|---|---|
| **Sources** | Files, URLs, uploads, feeds (V1+) | `wiki_section_urls`, `wiki_section_uploads` (V1) + section-junction links |
| **Call Transcripts** | Immutable record of voice sessions | `call_transcripts` |
| **Wiki** | Knowledge graph (user-scope + per-agent-scope) | `wiki_pages` + `wiki_sections` |
| **Todos** | Intents and actions, user- or agent-assigned | `wiki_pages` (type='todo') + `agent_tasks` for agent-assigned |
| **Plugins** | Installed capabilities — kind + handler + artifact table + UI module | Registry (code) + per-kind tables |
| **Connectors** (V1+) | 3rd-party integrations with state | `connectors` table |
| **Artifacts** | Agent-produced outcomes | Per-kind tables (`research_outputs` MVP; podcasts/email/calendar/briefs V1) + Storage buckets for binaries |
| **Agents** | Personas — name, voice, prompt, private wiki | `agents` table |

**Wiki and Todos are core built-in UI surfaces, not plugins.** They project over `wiki_pages` (with `type='todo'` filter for the Todos UI) via client-side query logic. No registry entries.

---

## Interaction modes

**MVP:** Call mode (voice via Gemini Live), with two call types — `generic` and `onboarding`.

**V1+** (see `backlog.md`): Text mode (parity with Call), Ask mode, Note mode.

---

## Client architecture

- **Path:** `apps/mobile/` (alongside `apps/server` + `apps/worker`)
- **Framework:** React Native + Expo
- **Voice agent:** Gemini Live
- **Audio:** React Native Audio API for mic streaming, playback, processing
- **Local data:** RxDB wrapping SQLite (via `expo-sqlite`), with Supabase replication plugin for two-way sync
- **State:** Zustand (lightweight, hooks-native); active call session held at app root so navigation away doesn't tear down the session
- **Navigation:** Expo Router (file-based)
- **Styling:** NativeWind with token-based theming from day one. Default theme: **Azure** (deep-blue ambient gradient, voice-first feel). Other Liquid Glass variants (Aurora, Ember, Verdigris, Void) tokened but switcher V1+. Light-mode tokens defined alongside dark; switcher V1+.
- **Auth:** Supabase Auth — **Apple + Google sign-in only** at MVP (no email/password)
- **Full-screen content:** safe areas respected for layout positioning; backgrounds always extend edge-to-edge (no solid-color blocks under safe area)

See `specs/mobile-app.md` for the full client SPEC (project structure, screens, component primitives, state stores, animations).

### Call session flow

1. User taps phone FAB → client calls `POST /calls/start` with `{ agent_slug, call_type, context_page_id? }`
2. Server validates, composes system prompt (7 layers: scaffolding → persona → ontology → capabilities → preload → recent activity → session context), returns Gemini Live config
3. Client opens Gemini Live WebSocket directly to Google with the composed config
4. Conversation flows; tool calls (`search_wiki`, `fetch_page`, Google grounding) routed through our server
5. User ends call (or silence timeout / network drop / app backgrounded)
6. Client posts to `POST /calls/:session_id/end` with full transcript
7. Server commits transcript + atomically enqueues ingestion job to `ingestion-${user_id}` Graphile queue
8. Worker processes ingestion (user-scope fan-out + agent-scope ingestion in parallel)

### Persona loading

Each call is initialized with the active agent's persona (default `Assistant` at MVP). Persona prompt + user_prompt_notes are sensitive — never persisted on client, never returned by arbitrary endpoints. Held in memory only for call duration; discarded on disconnect. See `specs/agents-and-scope.md` Invariant 3.

---

## Server architecture

- **Framework:** NestJS
- **Datastore:** Supabase (Postgres + Auth + Realtime + Storage)
- **AI SDK:** `@google/genai` directly (no Langchain)
- **Inference provider:** Gemini-only at MVP (Flash for retrieval / lightweight, Pro for fan-out + research, Live for in-call)
- **Background jobs:** Graphile Worker (Postgres-backed, runs in dedicated Render service separate from the API)
- **Deployment:** Render — `apps/server` (API) + `apps/worker` (Graphile runner) as separate services
- **ORM:** Drizzle for Postgres access + schema-first migrations
- **Local dev:** Supabase CLI for local Postgres + Realtime

### Background-loop architecture

See §11 in `todos.md` for the full SPEC across 5 chunks. Summary:

- **Two queues:** `ingestion-${user_id}` (per-user serialization for transcript ingestion) and `agent_tasks` (shared, all kinds + users).
- **Atomic enqueue:** application code creates `agent_tasks` row + calls `add_job()` in same transaction. CRON scanner (every 30s) handles delayed/retry pickup.
- **Plugin registry** (TS module): one entry per kind with `{prompt, handler, schemas, capabilityDescription, requiredConnectors, artifactKind, modelTier, tokenBudget, timeoutMs, maxAttempts, …}`. Split into full server-only `pluginRegistry` + derived client-safe `pluginRegistryLite`.
- **MVP plugin: `research` only.** V1+ adds podcast, email_draft, calendar_event, brief.
- **Capability-availability levels:** System / Tier-granted / User-enabled / Connector-ready. Backend enforces all four at task dispatch; call-agent sees level 4 only; fan-out sees level 3.
- **Handler contract:** `(ctx) => Promise<{output, sources, reingestIntoWiki?}>`. Backend commits artifact + source junctions + status update in one transaction at end of handler.
- **Idempotency:** transactional commit at end of handler; LLM calls re-run on retry (cost-acceptable at MVP).
- **Conservative retry:** 1–2 attempts max, retry only on `RetryableError` (rate limit / timeout / network), `PermanentError` / `ValidationError` fail-fast.
- **Observability:** pino structured logs with correlation context (`user_id, agent_tasks_id, kind, graphile_job_id, retry_count`); Sentry for errors; ad-hoc SQL for queue/task metrics; no metrics infra at MVP.

---

## Knowledge graph design

### Inspiration

Karpathy's "LLM Wiki" pattern: knowledge as interlinked markdown pages, AI-maintained. Markdown is readable to both user and LLMs. The AI handles bookkeeping (cross-references, abstracts, supersession) so the graph stays healthy at near-zero maintenance cost.

### Adaptations for Constellate

Karpathy's pattern is document-centric. Constellate is conversation-centric — a 30-minute call is a stream of dozens of micro-facts that fan out across many pages. The server-side ingestion pipeline owns that fan-out.

### Scopes

Two scopes enforce a privacy partition:

- **`scope='user'`** — the user's knowledge graph, fully visible + editable. Examples: profile, goals, values, work, people, projects, concepts, sources, notes, todos.
- **`scope='agent'`** — each agent persona's private notes about the user (observations, inferred patterns, working theories). Readable by the user (transparency), not directly editable. Strictly partitioned per-agent — Assistant's notes invisible to a future Health Coach (V1+) and vice-versa.

**Per-agent partitioning** via `wiki_pages.agent_id` column + RLS policies. See `specs/agents-and-scope.md` for the full multi-agent data model (designed for many, operated at N=1 for MVP).

### Page typing

Each page has a `type` driving AI expectations + UI folder placement. Body is markdown sections.

**User-scope types (MVP):** `person, concept, project, place, org, source, event, note, profile, todo`.
**Agent-scope:** single `agent` type; one root page per agent + organic descendants.

`research` is NOT a wiki type — research outputs live in their own `research_outputs` table. Same for V1+ artifact kinds. **Wiki = distilled knowledge; artifacts = AI-produced outputs.** See `tradeoffs.md` "Artifacts as per-plugin tables."

### Sectioned pages

Pages decompose into **sections** (`wiki_sections`), the unit of editable content (h2-granularity; h3+ stays in section markdown). The fan-out prompt emits targeted section keep/update/create/tombstone operations rather than full-page rewrites — turns update cost from O(page size) to O(changed section size). Pro reads the fully-joined page for context but writes at section granularity.

**Timeline section** is a special section (`title='Timeline'`) added when a contradiction arrives. Flat newest-first bullet list with bold temporal annotations (`**Current** — `, `**Past** — `, `**April 2026** — `, etc.). Acts as the conflict-resolution mechanism for 1:1 attribute changes; additive claims (more goals, more friends) don't go through Timeline. See `specs/fan-out-prompt.md` §4.4 for the full operation.

### Hierarchy

`parent_page_id` self-reference on `wiki_pages`. Unlimited nesting. Used for:
- Profile organized via root + children (Goals, Values, Life-History, Health, Work, Interests, Relationships, Preferences, Psychology — all `type='profile'`)
- Todos as bucket pages (`todos/todo`, `todos/in-progress`, `todos/done`, `todos/archived`)
- Project sub-pages (custom user-organized)
- Agent's own private subtree

Reparenting allowed; slugs stable across reparents (per two-track slug strategy below). Tombstone blocks if non-tombstoned children exist (user must reparent or tombstone children first).

### Slug uniqueness — two-track strategy

Slugs are unique per `(user_id, scope)`.
- **Standard (long-lived semantic types):** `person, project, concept, profile, source, place, org, note` — walk-up rule. Kebab-case title; on collision prepend parent slug, walk up until unique. Numeric suffix as last resort.
- **High-churn types:** `todo` (and `event` likely) — `{kebab-title}-{4-char-uuid-hash}`. No walk-up; hash disambiguates. Motivated by systematic reparenting (todos cycling status buckets fragment walk-up slugs silently).

### `agent_abstract` + `abstract`

Two abstract fields per page:
- **`agent_abstract`** (required, terse, ~1 sentence) — machine-consumed; surfaced in wiki index, preloads, cross-reference resolution. First-class LLM prompt input.
- **`abstract`** (nullable, human-readable lead, multiple sentences) — rendered between title and first section in UI.

Both AI-regenerated on page-touching writes.

### Source junctions

Every fact is grounded. Per-entity section-level junction tables:
- `wiki_section_transcripts(section_id, transcript_id, turn_id, snippet, cited_at)` — transcript-sourced (primary MVP path)
- `wiki_section_urls(section_id, url, snippet, cited_at)` — URL-sourced
- `wiki_section_ancestors(section_id, ancestor_page_id, snippet, cited_at)` — derived from existing wiki pages
- `wiki_section_uploads(section_id, upload_id, snippet, cited_at)` — V1
- Per-artifact-kind junctions when re-ingestion lands V1+ (`wiki_section_research`, etc.)

User edits don't need a source row — `wiki_section_history.edited_by='user'` is the provenance.

### Mutability

- Append-only at fact level; newest-wins on read
- Personal facts superseded by newest; objective facts not overwritten by contradicting claims
- User edits tombstoned, not hard-deleted
- Section-level history (`wiki_section_history`) with full content snapshots per edit; page-level events in `wiki_log`

### Index

Wiki index = materialized view / API endpoint over `wiki_pages` (not a stored file). Compact form: `{slug, title, type, parent_slug, agent_abstract}`. Rendered as markdown on demand for system-prompt injection at call start.

### `wiki_log`

Append-only chronological event log. Kinds: `'ingest'` (user-scope), `'agent_scope_ingest'`, `'query'`, `'lint'`, `'task'`. Captures page-level creation/tombstone events too. Source for the activity stream + recent-activity preload layer.

---

## Data model

```sql
-- Identity + agents
auth.users                       -- Supabase Auth managed
agents (
  id, user_id, slug, name, voice, persona_prompt,
  user_prompt_notes (nullable), root_page_id, is_default,
  created_at, tombstoned_at
)
user_settings (
  user_id PK, enabled_plugins text[], ...
)

-- Wiki
wiki_pages (
  id, user_id, scope ('user' | 'agent'), type, slug, parent_page_id,
  title, agent_abstract, abstract (nullable), frontmatter jsonb,
  agent_id (nullable; required when scope='agent', CHECK enforced),
  created_at, updated_at, tombstoned_at
)
wiki_sections (
  id, page_id, title (nullable), content, sort_order,
  created_at, updated_at, tombstoned_at,
  UNIQUE (page_id, title) WHERE title IS NOT NULL
)
wiki_section_history (
  id, section_id, content, edited_by ('ai' | 'user' | 'lint' | 'task'),
  edited_at
)
wiki_section_transcripts (section_id, transcript_id, turn_id, snippet, cited_at)
wiki_section_urls (section_id, url, snippet, cited_at)
wiki_section_ancestors (section_id, ancestor_page_id, snippet, cited_at)

-- Tags
tags (id, user_id, name, color)
wiki_page_tags (page_id, tag_id)

-- Activity log
wiki_log (id, user_id, kind, ref, summary, created_at)

-- Calls
call_transcripts (
  id, user_id, agent_id, session_id UNIQUE, title, summary,
  started_at, ended_at, content jsonb,           -- turn-tagged
  tool_calls jsonb (nullable),                   -- per-turn tool invocations + citations
  dropped_turn_ids text[],                        -- user-confirmed drops
  cancelled bool default false,                   -- user-cancelled calls skip ingestion
  end_reason text
)

-- Background tasks
agent_tasks (
  id, user_id, todo_page_id (FK → wiki_pages), agent_id (FK, nullable),
  kind, payload jsonb, status, priority, scheduled_for,
  started_at, completed_at, retry_count, last_error,
  graphile_job_id, result_artifact_kind, result_artifact_id
)

-- MVP plugin: research
research_outputs (
  id, user_id, agent_tasks_id, query, findings jsonb, summary,
  generated_at, model_used, tokens_in, tokens_out, tombstoned_at
)
research_output_sources (research_output_id, url, snippet, cited_at)
research_output_ancestors (research_output_id, ancestor_page_id, snippet, cited_at)

-- Cost tracking
usage_events (
  id, user_id, agent_id (nullable), agent_tasks_id (nullable),
  event_kind, input_tokens, output_tokens, cached_tokens, model,
  cost_cents, artifact_kind (nullable), artifact_id (nullable),
  call_transcript_id (nullable), created_at
)
```

V1+ adds: `connectors`, `notifications`, `recommendations`, `schedules`, `uploads`, `proposed_action_items`, per-V1-plugin artifact tables (`podcasts`, `email_drafts`, `calendar_events`, `briefs`), `wiki_section_uploads`, `wiki_section_research` (when re-ingestion enabled), `wiki_section_<kind>` per re-ingesting plugin.

### Indexes

See `todos.md` §3 "Indexes — explicit plan" for the full per-table index list.

### RLS

Server-side full access; client (RxDB sync) restricted to user-scope content + sanitized agent display metadata. Persona prompt fields excluded from any client-facing view. See `todos.md` §3 "RLS policy set" for per-table policies. Cross-agent leakage tests enumerated in `todos.md` §3.

### Sync model

- Server is source of truth
- Client maintains RxDB-wrapped SQLite mirror via Supabase replication plugin
- **Conflict resolution:** server-wins for AI writes; LWW for user edits via RxDB defaults; section history preserves both versions
- **Offline:** reads cached locally; writes queue + replay on reconnect; calls require connectivity (Gemini Live)
- **Initial hydration:** paginated backfill ordered by `updated_at DESC` + realtime sync after

---

## Server-side ingestion pipeline

8 conceptual stages, 2 LLM calls + mechanical commit at MVP. See `notes/ingestion-pipeline.md` for the full breakdown.

### Phase 1 — Retrieval (Flash)
1. **Candidate retrieval** — Flash reads transcript + compact wiki index; emits `touched_pages` (existing slugs to update) + `new_pages` (proposed creates). Empty arrays = noteworthiness gate fails; pipeline short-circuits. See `specs/flash-retrieval-prompt.md`.

### Phase 2 — Parsing (Pro)
Single Pro call covering stages 2–7 against transcript + full joined content of every Flash candidate page:
2. Claim extraction (atomic granularity)
3. Per-claim noteworthiness filter
4. Routing + entity resolution (constrained to candidate set; multi-target writes allowed)
5. Contradiction detection (with refinement / correction carveouts; Timeline section operation when needed)
6. Section write set + abstract regeneration
7. Source attribution per section

Output: `{creates, updates, skipped}` with section-level operations. See `specs/fan-out-prompt.md`.

### Phase 3 — Commit (backend)
8. Transactional DB commit — `wiki_pages` + `wiki_sections` + `wiki_section_history` + `wiki_section_transcripts` + `wiki_log`. Atomic.

### Agent-scope ingestion (parallel pass)

Single Flash call writes observational notes to the active agent's private wiki. Runs in parallel with user-scope fan-out (independent failure isolation). Different decision rules — observations not facts; substance-not-repetition skip-default. See `specs/agent-scope-ingestion.md`.

### Ingestion is queued

Both passes enqueue to `ingestion-${user_id}` Graphile queue. Per-user FIFO serialization prevents same-user race conditions. Different users process in parallel. Atomic commit + enqueue from `POST /calls/:session_id/end`; idempotent on `session_id`.

---

## Onboarding

See `specs/onboarding.md` for the full spec. Summary:

1. **Signup:** Supabase Auth user created
2. **Seed transaction:** 1 `agents` row + 20 `wiki_pages` rows (5 agent-scope + 10 profile + 5 todos) + 1 `user_settings` row, atomic
3. **Onboarding interview:** Gemini Live call with `call_type='onboarding'`. Opens with brief Muse self-intro + opener ("What brings you to Muse?"). Structured-but-conversational; targets 7 askable profile areas (Values + Psychology emergent-only, never explicitly asked); tracks progress in-call. Capability advertisement is slightly proactive but tied to stated needs.
4. **"Good enough" heuristic:** target ~10 min average. Wraps when 4+ of 7 askable areas covered substantively, OR user signals done, OR 15-min soft cap reached.
5. **Resumable:** user can skip and return from settings later.
6. **Post-onboarding:** standard ingestion runs against transcript; profile pages populated from extracted claims. Agent-scope ingestion captures initial observations.

No mid-call task kickoff (trial artifacts deferred to V1+ per `backlog.md`).

---

## Sources & grounding

Every fact in the KG is grounded; generalizes to every derived artifact. Section-level per-entity junction tables capture the link from each section to its grounding source (transcript turn, URL, ancestor wiki page, upload V1, research output V1 when re-ingestion lands).

User edits live in `wiki_section_history.edited_by='user'` — no dedicated source row needed.

UI-level surfacing of sources (per-page sidebar / inline citations / drill-down) — V1+ design pass.

---

## Auth, security, privacy

- **Auth provider:** Supabase Auth
- **Auth methods (MVP):** email + password; Apple + Google sign-in flagged for V1
- **RLS:** see `todos.md` §3 for per-table policies + cross-agent leakage tests
- **Persona prompt protection:** never persisted on client, never returned by arbitrary endpoints; only embedded in composed system prompt at session init
- **Secret management:** server env vars; per-user OAuth tokens in Supabase Vault (V1+ when connectors land)

V1+ work (rate limiting, abuse ceilings, account deletion, data export) tracked in `backlog.md`.

---

## Cost & inference strategy

- **Gemini-only at MVP** — Flash for retrieval / agent-scope ingestion, Pro for fan-out + research, Live for in-call
- **Explicit caching:** call-agent scaffolding, fan-out main prompt, research scaffolding, agent-scope scaffolding, onboarding scaffolding (one cache per kind, per prompt-version, long TTL, refreshed by recurring Graphile job)
- **Sectioned writes** keep page-edit costs bounded at MVP (changed section size, not page size)
- **`usage_events` table** tracks per-call cost; tier-gating + pricing model deferred to V1+
- **No metrics infra at MVP** — ad-hoc SQL + Sentry + (V1+) PostHog server-side events

---

## UX surfaces (MVP set)

- **Wiki module** (core, projection over `wiki_pages` + `wiki_sections`): browse + edit; virtual folders by `type`; hierarchy tree.
- **Todos module** (core, projection over `wiki_pages WHERE type='todo'` joined with `agent_tasks`): task-management UX with status tabs + check-off + assign-to-agent.
- **Research module** (artifact-backed): library + detail view + spawn-research affordance.
- **Phone FAB:** ubiquitous across screens; starts a call.
- **Call-history surface:** transcript browse.
- **Activity-stream + notifications:** in-app only at MVP (push deferred V1+).
- **Onboarding flow:** auto-launches on signup; resumable from settings.

V1+ surfaces (Podcasts, Gmail, Calendar, Briefs UI modules; Graph view; explicit project/page pinning; etc.) tracked in `backlog.md`.

---

## Cross-cutting principles enforced in code

- **Activity-stream coverage** — every feature that produces work writes a `wiki_log` entry
- **Graph citizenship** — every artifact knows its provenance (sources) + downstream consumers (junctions)
- **Manual override** — every automation (todo creation, ingestion, agent_tasks) has user-visible state + ability to amend/cancel
- **Filable outputs** — every generated output lands somewhere queryable (per-kind artifact table for plugins; wiki for ingestion)

---

## Definition of "ready to start production coding"

Per `todos.md` §24 — most items now ✅. Remaining open: Connectors design (V1+), pricing/tier model (V1+), and `architecture.md` + `features.md` sync (this doc + features.md just landed).

Code phase begins with: schema migrations, RLS policies, RxDB sync wiring, the call-agent + ingestion + research handler stack, then the UI modules.

---

## Companion documents

- `todos.md` — authoritative decision checklist with status markers
- `tradeoffs.md` — decisions where alternatives were weighed
- `backlog.md` — V1+ deferred work sorted by priority + effort + type
- `judgement-calls.md` — autonomous-spec-completion decisions made without explicit user confirmation
- `features.md` — feature catalog (target horizon)
- `notes/` — working notes (data-flow architecture, ingestion pipeline)
- `specs/` — per-area detailed specs (fan-out, Flash retrieval, agents-and-scope, agent-scope ingestion, onboarding, research-task)
