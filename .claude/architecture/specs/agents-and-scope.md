# SPEC — Agents and scope partitioning

Status: **draft** — decision shape locked; data-model details + ingestion pass design remain.

Captures the multi-agent data model, persona loading, per-agent scope partitioning, and the separate agent-scope ingestion pass. Designed for multi-agent even though MVP ships with N=1 (the default `Assistant` agent); the table and column shape avoid any schema migrations when custom agents land.

Companion to `todos.md` (decision checklist) and `tradeoffs.md` (design tradeoffs).

---

## Purpose

Each user has one or more **agents** — personas with distinct names, voices, and system prompts, each backed by its own private wiki. Agents share read access to the user's wiki but are strictly partitioned on the agent-scope side. MVP ships with one seeded `Assistant` agent; custom agents are a V1+ feature with no schema churn at that point.

The system is designed for multi-agent from day one. Operating at N=1 is a product decision, not an architectural one.

---

## Core model

### `agents` table

Per-user rows, one per persona.

```
agents:
  id               uuid PK
  user_id          uuid FK → auth.users
  slug             text           -- stable identifier, kebab-case
  name             text           -- display name ("Assistant", "Health Coach")
  voice            text           -- TTS voice identifier (provider-dependent; see Open Questions)
  persona_prompt   text           -- system-prompt fragment defining personality, style, boundaries
  user_prompt_notes text NULL     -- user-editable additions to the persona prompt
  root_page_id     uuid FK → wiki_pages
  is_default       bool           -- true for the seeded Assistant
  created_at       timestamptz
  tombstoned_at    timestamptz NULL

UNIQUE (user_id, slug)
```

**Why `user_prompt_notes` as a distinct field:** lets the user add "please always call me by my first name" or "I prefer direct feedback over soft suggestions" without overwriting the built-in persona. The runtime concatenates `persona_prompt` + `user_prompt_notes` at session start.

### `agent_id` column on `wiki_pages`

```
wiki_pages:
  ...existing columns...
  agent_id uuid FK → agents  NULL  -- required when scope='agent', must be NULL when scope='user'
```

Nullable overall, but a CHECK constraint enforces:
- `scope = 'user'` → `agent_id IS NULL`
- `scope = 'agent'` → `agent_id IS NOT NULL`

**Why denormalize (vs. walk up `parent_page_id` to find the owning agent):** agent-scope reads happen on every call preload and every agent-scope ingestion pass. A join/CTE walk-up on every read is wasteful when a single indexed column answers the question in O(1).

### Indexing

- `(user_id, scope, agent_id)` — primary filter for preload + ingestion
- Existing indexes on `wiki_pages` continue to work unchanged

### Slug uniqueness

Existing convention: slugs are unique per `(user_id, scope)`. That still holds. Under agent scope, the full uniqueness key is effectively `(user_id, scope='agent', agent_id, slug)` — but since different agents' subtrees are functionally independent, collisions across agents don't matter semantically, and enforcing uniqueness per `(user_id, scope)` remains simplest.

Practical upshot: an agent's own slug (e.g., `assistant`, `health-coach`) is the slug of its root page, unique per user.

---

## Persona loading

### Session initiation

A call (Live session) is initiated with an `agent_slug` parameter. MVP defaults to `assistant`; the slug is explicit so the same entry point works when custom agents arrive.

Server-side session start:

1. Fetch the `agents` row for `(user_id, agent_slug)`.
2. Compose the Gemini Live system prompt:
   - Base Muse scaffolding (shared across agents)
   - `persona_prompt` + `user_prompt_notes`
   - User-wiki preload (shared across all agents for this user)
   - Active agent's wiki preload (scoped to `agent_id = agents.id`)
3. Configure TTS with `voice`.
4. Start the session.

### Preload scope

- **User wiki**: shared. Every agent sees the same user-wiki content.
- **Agent wiki**: strict per-agent partitioning. The Assistant's private notes are invisible to the Health Coach and vice-versa.

Both are preloaded according to the §8 preloaded-slice SPEC (compact index + prioritized content).

---

## Agent-scope ingestion — separate pass

The Pro fan-out pipeline currently operates exclusively on user-scope pages (see `specs/fan-out-prompt.md` §4.3 + output-contract rules). That invariant **stays**. Agent-scope writes happen in a **separate, lightweight pass** — not by expanding Pro to write to both scopes in one call.

**Why separate:**
- Strict isolation reduces cross-scope leak surface area (no "Pro emitted to agent-scope by mistake" failure mode).
- Agent-scope writes are observational and short-form ("user mentioned feeling burnt out"); they don't need Pro's full contradiction/routing machinery.
- Keeps the fan-out prompt focused on the hardest work (user-wiki KG maintenance).
- Simpler to reason about, evaluate, and cost-track.

### Shape of the agent-scope pass

To be specified as a sibling SPEC (`specs/agent-scope-ingestion.md`), but the shape is:

- Runs after (or in parallel with) the user-scope fan-out.
- Uses Flash (not Pro) — agent-scope writes are observational, not structurally complex.
- Input: same transcript + active agent's private wiki (compact + preloaded slice).
- Output: append-only notes or small section updates under the active agent's root page.
- Output volume is expected to be *lower* than user-scope (observations are a subset; most claims land on user pages).
- Inherits the security invariants from Pro: LLM never emits `user_id`, `scope`, `agent_id` — backend injects from the active session.

### Content shape of an agent's private wiki

Loose guidance; each agent's subtree is free-form:

- `observations` — ongoing noticing about the user
- `open-questions` — things the agent wants to explore next time
- `preferences-noted` — inferred preferences not promoted to the user profile
- Bespoke pages created by the agent-scope pass as context accumulates

These are seeded at agent creation but the structure can evolve organically.

---

## Privacy invariants

### Invariant 1 — Agent-scope pages never leave the server

(Already established — see §3 / §20 in `todos.md`.) Preserved unchanged.

### Invariant 2 — Cross-agent partitioning

An agent-scope page is visible only to the agent that owns it. RLS must filter by `(user_id = :user_id AND scope = 'agent' AND agent_id = :active_agent_id)` on every agent-scope read. Cross-agent reads are disallowed even within the same user.

Implication: the Assistant's observations about the user never reach the Health Coach, and vice versa. Each persona has independent long-term memory.

### Invariant 3 — Persona prompts are never persisted on the client and never retrievable via client-invokable endpoints

`agents.persona_prompt` and `user_prompt_notes` are sensitive (they shape agent behavior; a prompt-injection vector if leaked, and reveal the agent's operational rules if extracted). They transit the client only as part of session initialization — the server composes a full system prompt in `POST /calls/start`'s response that embeds the persona text; the client feeds that composed prompt to the Gemini Live WebSocket and holds it in memory for the duration of the call, discarding on disconnect.

The prompt must never:
- Be persisted to RxDB, SQLite, or any local client storage
- Be returned by arbitrary read endpoints (no `GET /agents/:id` exposes `persona_prompt`)
- Be logged or sent to analytics or any non-Gemini third-party service
- Be echoed in debug views, crash reports, or error messages

The only literal "server-only" architecture would proxy the Gemini Live session through the backend (server ↔ Gemini, client ↔ server audio). That's infeasible for MVP — real-time audio latency + server bandwidth cost. The clarified invariant describes the actual discipline: ephemeral client residency, bounded to session duration, never stored.

### Tests

New leak-prevention suite additions:
- Agent-scope read with wrong `agent_id` returns empty.
- Agent-scope read without `agent_id` (simulating bug) returns empty, not "all agents."
- User-scope writes cannot fabricate `agent_id` or `scope='agent'`.
- Persona-prompt fields never appear in any client-bound response.

---

## Seeding

### At signup

1. Create a `wiki_pages` row: `slug='assistant'`, `scope='agent'`, `agent_id` set to the agent's id (self-reference via post-insert update, or a transaction where `agents.id` is generated first and used for both rows). `parent_page_id = NULL`.
2. Create the `agents` row with `is_default = true`, `root_page_id` pointing at (1).
3. Optionally seed stub child pages under the root (`observations`, `open-questions`, etc.) — content TBD in the onboarding SPEC.

### At custom-agent creation (V1+)

Same pattern — new `agents` row + new root `wiki_pages` row + optional seed subtree. No schema migration needed.

### Default Assistant as non-deletable

MVP: the default Assistant cannot be tombstoned (app-level check — users always need a default). Custom agents are freely deletable with cascade-tombstone of their agent-scope subtree (V1+ decision, deferred).

---

## MVP scope (N=1)

What ships on day one:

- `agents` table with exactly one row per user (the default Assistant), seeded at signup.
- `agent_id` column populated on the Assistant's subtree.
- Persona prompt + voice defaulted; no user-editing UX for these yet.
- Call initiation hardcoded to `agent_slug = 'assistant'`.
- Agent-scope ingestion pass runs against the Assistant's subtree.

What V1+ unlocks without schema churn:

- Custom agent creation UX.
- Agent-picker in call initiation.
- Persona editing (name, voice, user_prompt_notes).
- Multi-agent switching mid-session (open — unclear whether this is ever a coherent UX).

---

## Open questions

- **Voice selection mechanism.** Gemini Live has a limited voice set; ElevenLabs or similar for richer voice variety adds cost + integration work. MVP probably uses Gemini's default voice and defers the picker. V1+ decision.
- **Agent deletion semantics.** Tombstone the `agents` row + cascade-tombstone the subtree? Or block deletion if the agent has substantial content? Defer to V1+.
- **Cost attribution per agent.** Multi-agent makes "which persona spent how much" a real question for §17 cost tracking. Defer but plan the token-usage table schema to carry `agent_id` from day one so backfill isn't needed later.
- **Mid-session agent-switching.** User starts with Assistant, mid-call says "actually, talk to the Health Coach about this"? Probably a forced call-end + new call, not a runtime switch. UX-level decision, deferred.
- **Onboarding for custom agents.** Does a newly-created agent run a truncated onboarding interview to establish its initial private wiki? Or start empty and accrete observations organically? V1+.
- **Agent-scope ingestion pass SPEC.** The shape is outlined here but the actual prompt + output contract deserves its own spec — `specs/agent-scope-ingestion.md`. Flagged as a new open item in §6 of `todos.md`.
- **Shared vs. per-agent onboarding.** The MVP onboarding interview populates user-scope profile pages (shared by all future agents). Should each custom agent also run a lightweight "who are you to the user?" interview? V1+.

---

## Related decisions

- `todos.md` §4 — scopes, types, hierarchy (updated to reflect multi-agent)
- `todos.md` §6 — agent-scope ingestion pass added as SPEC item
- `todos.md` §8 — call mode persona loading
- `todos.md` §20 — cross-agent leakage tests added
- `tradeoffs.md` — multi-agent at N=1, per-agent partitioning, separate agent-scope pass
- `specs/fan-out-prompt.md` — user-scope-only invariant reaffirmed
- `notes/data-flow-architecture.md` — agents as first-class in the data flow
