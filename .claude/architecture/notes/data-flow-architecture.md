# Data-flow architecture

System-level view of how information moves through Constellate. This is the conceptual spine — most subsystems, SPECs, and UX surfaces derive from this flow.

---

## The flow

```
Sources & Conversations  →  Wiki & Todos  →  Artifacts & Connectors
        (input)                (memory)         (execution)
```

Every operation in the system fits somewhere on this chain. The chain is also bidirectionally navigable — audit trails go upstream (what produced this?), downstream (what did this produce?), and laterally (what else is related?).

### Stage 1 — Input (Sources & Conversations)

- **Conversations**: voice calls with an agent persona; text messages when voice isn't possible; onboarding interviews.
- **Sources**: user-uploaded files, URLs, audio, images; RSS feeds from content partnerships; integration-sourced content from connectors.

All input is normalized into an ingestible form (transcript, extracted text, structured payload) and routed into the same ingestion pipeline.

### Stage 2 — Memory (Wiki & Todos)

- **Wiki**: the knowledge graph. User-scope pages describe the user's world (people, projects, concepts, preferences, profile). Agent-scope pages are each agent's private observational memory.
- **Todos**: the action surface. Any commitment or action-needed surfaced from conversation becomes a todo. Assignee is either `user` (reminder) or `agent` (agent-executed action).

Ingestion is the mechanism that moves from stage 1 to stage 2 — claim extraction, routing, contradiction handling, todo creation (see `specs/fan-out-prompt.md` and `specs/flash-retrieval-prompt.md`).

### Stage 3 — Execution (Artifacts & Connectors)

- **Artifacts**: in-app generated outcomes — research reports, podcasts, briefs, drafted emails, calendar event proposals. Each artifact kind lives in its **own dedicated table** (`research_outputs`, `podcasts`, `email_drafts`, `calendar_events`, `briefs`) with a bespoke schema; binary payloads (podcast audio) live in Supabase Storage with a thin table row holding the ref + metadata. Artifacts are NOT `wiki_pages` — wiki is for distilled knowledge, artifacts are AI-produced outputs.
- **Text artifacts *may* re-ingest into the wiki (V1+, off at MVP)**: research outputs and briefs can optionally fan out findings into the user's wiki pages as a follow-on ingestion step, with the artifact serving as the *source* for those wiki sections (via per-kind junction tables like `wiki_section_research`). Controlled per-kind by `registry[kind].reingestsIntoWiki`; **all kinds default `false` at MVP** — findings live in the artifact table only, surfaced via the plugin's UI module.
- **Connectors**: 3rd-party read/write integrations — email, calendar, Linear, Google Drive. State-bearing (OAuth tokens, rate limits, capability scopes).

Execution is driven by agent-assigned todos picked up from a queue. Artifact-producing kinds write to their artifact table; connector-writing kinds hit external APIs with receipts logged to the originating `agent_tasks` row and the connector's own audit log.

---

## The universal trigger: agent-assigned todos

Every agent action in the system — every artifact, every connector write — is mediated by a **todo of a specific kind**. The todo kind determines:

- Which prompt runs to produce the output
- Whether the output is an internal artifact (lands as a wiki page) or external (hits a connector)
- Where the receipt/result is filed back
- Which registry entry the call-agent references to know the capability exists

Adding a new agent capability means:

1. Add a new kind to the todo-kind enum
2. Write its generative prompt
3. Make the call-agent aware (exposed via the capability registry the call-prompt reads)
4. (Optional) Add artifact-specific schema / output-page type

No changes to ingestion, CRON dispatcher, or activity stream. This is the core modularity argument for the architecture.

### Call → todo → execution

Concrete flow for a typical agent action:

1. User on a call: "can you research Italian restaurants near me?"
2. Call ends, transcript ingested (via the `ingestion` Graphile queue, with per-user serialization via `job_key`).
3. Fan-out extracts a claim that maps to a `research` todo (assignee=agent), creates a todo wiki page with frontmatter payload, and writes an `agent_tasks` row linked to the todo page.
4. A CRON scanner polls `agent_tasks` for `status='pending'`, enqueues a Graphile job on the `agent_tasks` queue.
5. Worker picks up the job, dispatches via the plugin registry (`registry.research.handler`), executes the research prompt.
6. Handler emits semantic JSON; backend validates against `registry.research.outputSchema`, writes a row to `research_outputs` with source links (cited URLs in `research_output_sources`, wiki ancestors in `research_output_ancestors`).
7. **(V1+, skipped at MVP.)** If `registry.research.reingestsIntoWiki === true` and handler didn't override, a follow-on ingestion job is enqueued with the artifact as source; findings fan out into wiki pages citing `wiki_section_research`. At MVP this step is skipped — research stays in its artifact table only.
8. Todo moves from `todos/todo` → `todos/done` (reparent); `agent_tasks.result_artifact_kind='research' / result_artifact_id=<uuid>` set, `status='succeeded'`.
9. Notification + activity-stream entry: "Research ready." Tap opens the Research UI module (not the wiki) to view the full artifact.

---

## First-class citizens

These are the top-level nouns users and the system reason about. Each has its own data shape, lifecycle, and surface area.

| Citizen | What it is | Data shape |
|---|---|---|
| **Sources** | Files, URLs, uploads, feeds | Dedicated table (V1+) + source-junction links to wiki sections |
| **Call Transcripts** | Immutable record of voice sessions | `call_transcripts` (existing) |
| **Wiki** | Knowledge graph (user-scope + per-agent-scope) | `wiki_pages` + `wiki_sections` |
| **Todos** | Intents and actions, user- or agent-assigned | `wiki_pages` (type='todo') + `agent_tasks` for agent-assigned |
| **Plugins** | Installed capabilities — each adds a todo kind + prompt + artifact table + UI module | Registry (code) + per-kind artifact table + per-kind UI module |
| **Connectors** | 3rd-party integrations with state | `connectors` table (new) |
| **Artifacts** | Agent-produced outcomes (research, podcasts, briefs, email drafts, calendar events) | Per-kind tables (`research_outputs`, `podcasts`, `email_drafts`, `calendar_events`, `briefs`) + Storage buckets for binaries |
| **Agents** | Personas — name, voice, prompt, private wiki | `agents` table (new, see `specs/agents-and-scope.md`) |

### Plugins as the extensibility mechanism

A plugin is the unit of installable capability, spanning three layers:

**(a) Backend registry entry** — a TypeScript module exports `pluginRegistry` mapping each `kind` to its full entry: generative prompt (path), handler function, input/output zod schemas, capability description, required connectors, artifact-kind reference, re-ingestion flag, model tier, token budget, timeout, max attempts, default priority. A derived `pluginRegistryLite` exposes only the client-safe fields.

**(b) Dedicated artifact table** — one table per kind (`research_outputs`, `podcasts`, etc.), with schema tailored to the kind. Binary kinds add a Storage bucket. Re-ingesting kinds add a `wiki_section_<kind>` junction table so wiki sections can cite the artifact.

**(c) First-class UI module** — each plugin ships a dedicated area of the mobile app (Wiki, Research, Podcasts, Gmail, Calendar, …). The module queries its own artifact table and renders kind-specific affordances — a podcast player, a research detail view, an email review+send flow, a calendar event confirm screen. The Wiki is one such module, not a privileged main surface.

### Capability-availability levels

Four levels determine what's actually usable:

1. **System** — every kind in the registry (what the codebase can do in principle).
2. **Tier-granted** — subset allowed by the user's subscription tier.
3. **User-enabled** — subset the user has explicitly enabled.
4. **Connector-ready** — subset whose `requiredConnectors` are connected and valid.

Enforcement:
- **Backend** (task dispatch validator) checks all four, rejecting at the highest unmet level with a message matched to the fix (upgrade tier / enable plugin / connect account).
- **Call-agent system prompt** composes descriptions from level 4 only — Muse doesn't advertise what the user can't currently use.
- **Fan-out prompt (Pro)** composes descriptions from level 3 (user-enabled) — commitments route into enabled plugins even if a connector is currently disconnected, so the user gets a "connect your account" prompt rather than a silent drop.

At MVP, plugins are first-party (research only). V1 adds podcasts, email drafts, calendar events, briefs. Third-party / runtime-installable plugins are V1++ at earliest — deferred until app bundle size or install flexibility becomes a concrete constraint.

### Connectors as stateful integrations

Connectors differ from plugins in that they bear durable per-user state:

- OAuth tokens (stored in Supabase Vault or per-user encrypted)
- Refresh cycles
- Rate-limit state
- Granted scopes

A connector exposes one or more *capabilities* that plugins can depend on (e.g., the `email` connector offers `send_email`; the `email_draft` plugin depends on that capability).

---

## Audit-trail affordances

The data flow is bidirectionally navigable. From any node, the user (and the system) can always:

- **Upstream**: what produced this? (A research page → which transcript / which todo / which prompt version.)
- **Downstream**: what did this produce? (A transcript → which wiki pages were touched, which todos were created, which artifacts were generated.)
- **Lateral**: what else is related? (Same subject, same project, same source.)

Mechanisms:

- Section-level source junctions (`wiki_section_transcripts`, `wiki_section_urls`, `wiki_section_ancestors`, `wiki_section_uploads`) plus per-artifact-kind junctions (`wiki_section_research`, etc.) — grounding upstream
- `wiki_log` — chronological ledger of ingest/query/task events
- `agent_tasks.todo_page_id`, `agent_tasks.result_artifact_kind`, `agent_tasks.result_artifact_id` — todo-to-artifact linkage (kind + id because artifacts live in per-kind tables)
- Per-artifact `<artifact>_sources` and `<artifact>_ancestors` tables — one level up in the chain (sources cited by an artifact)
- Activity stream — mixed-type feed of stage-3 events

### Contextual affordances

From *anywhere* in the chain, the user should be able to kick off an action on the current context. Examples:

- Viewing a project wiki → "upload a source to this project" (no page change)
- Viewing a source → "spawn research / podcast from this"
- Viewing a call transcript → "what pages did this update?" inline
- Viewing a research artifact → "which sources grounded this?"

These are UX-level affordances, but they only work because the underlying graph citizenship is uniform.

### Artifact immutability

Some artifacts are immutable once produced — podcasts are the canonical example (a generated audio file is a snapshot, not an editable document). Immutability is a per-kind concern enforced at the table level: the backend simply doesn't expose edit endpoints for immutable artifact kinds. Research and briefs are immutable too; email drafts are editable until sent; calendar events are editable until confirmed.

---

## Call *and* text

Voice is primary, but users can't always talk (loud environments, meetings, shared spaces). Text-based interaction is a first-class fallback mode sharing the same ingestion pipeline and agent scaffolding.

The pipeline is mode-agnostic: a text "session" produces a transcript exactly like a call does, just with different input/output plumbing. The fan-out, agent-scope pass, and todo-creation all work identically.

See `todos.md` §9 for the interaction-modes decision set.

---

## What this architecture does NOT cover

- **Compute/model routing**: which calls go to Flash vs. Pro vs. Live. See §17 cost strategy + §2 tech stack.
- **RLS policies**: the enforcement mechanics for scope + agent partitioning. See `specs/agents-and-scope.md` and §20 auth/security.
- **Billing & usage accounting**: cross-cuts every stage. See the dedicated section in `todos.md`.

---

## Related documents

- `specs/fan-out-prompt.md` — how sources become wiki writes (user-scope)
- `specs/flash-retrieval-prompt.md` — candidate retrieval for ingestion
- `specs/agents-and-scope.md` — agent data model + cross-agent partitioning
- `todos.md` — detailed checklist; each first-class citizen has corresponding sections
- `tradeoffs.md` — design tradeoffs per decision
