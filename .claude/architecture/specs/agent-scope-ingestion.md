# SPEC — Agent-scope ingestion pass

Status: **draft** — Chunks 1 + 2 both locked. Prompt-text drafting + worked examples + evals remain.

The agent-scope ingestion pass writes observational notes from a call transcript into the **active agent's private wiki** (scope='agent', agent_id={active_agent}). It runs in parallel with the user-scope Pro fan-out (`specs/fan-out-prompt.md`), shares the same `ingestion-${user_id}` Graphile queue for per-user serialization, and is strictly isolated from user-scope content. Each agent persona accumulates its own private observations of the user; cross-agent reads are disallowed.

This spec is a sibling to `specs/fan-out-prompt.md` and `specs/flash-retrieval-prompt.md`. Decisions captured here are the ones the pass must follow to satisfy the architectural decisions made in `todos.md` §4 (per-agent partitioning), §6 (separate pass), and `specs/agents-and-scope.md`.

---

## Purpose & scope

The user-scope Pro fan-out captures **facts** about the user's world — people, projects, concepts, todos, profile updates. The agent-scope pass captures **patterns** — what each persona notices about the user across conversations: communication style, recurring concerns, areas of curiosity, emotional weather, productivity habits.

Different personas notice different things:
- **Assistant** observes general productivity, preferences, recurring asks
- **Health Coach** (V1+) observes wellness patterns, energy, mood-around-health
- **Therapist** (V1+) observes emotional patterns, self-reflection style
- **Custom personas** (V1+) observe what their persona prompt directs

Each persona's observations are **private to that persona** — strict per-agent partitioning enforced by RLS (`specs/agents-and-scope.md` §139).

---

## Pipeline shape

### Trigger

Every successfully-committed transcript fires agent-scope ingestion in **parallel** with user-scope fan-out. Both jobs enqueue to the same `ingestion-${user_id}` Graphile queue, ensuring per-user serialization across both passes for the same user (no race on shared resources) but independent failure handling.

User-cancelled transcripts (`call_transcripts.cancelled=true`) skip agent-scope ingestion just as they skip user-scope.

No noteworthiness gate at MVP — every committed transcript runs the pass. Flash cost is low enough that always-on is the right tradeoff.

### Model

Single **Flash** call. No companion retrieval pass (the active agent's private wiki loads entirely; it stays small).

### Pipeline diagram

```
Transcript committed
        │
        ├──→ [user-scope fan-out: Flash retrieval → Pro main → backend commit]    (existing)
        │
        └──→ [agent-scope: Flash → backend commit]                                  (this pass)
```

Both jobs serialize within the user's queue but are independent in their lifecycles.

---

## I/O contract

### Input

```ts
{
  transcript: Transcript               // turn-tagged, identical shape to user-scope (§8 Chunk 5)
  agent_wiki: {
    agent_slug: string
    persona_summary: string             // short distillation of persona's observation focus
    pages: Array<{
      slug: string
      title: string
      sections: Array<{ id, title, content }>
    }>
  }
  user_profile_brief: {
    name?: string
    timezone?: string
    // intentionally minimal — see "Why minimal context" below
  }
  call_metadata: {
    started_at: string                  // ISO 8601
    ended_at: string                    // ISO 8601
    end_reason: string
  }
}
```

### Why minimal context

- **No user-scope wiki content.** Observations are about *the user's patterns*, not *facts about the world*. The agent doesn't need to re-read the user wiki to notice that the user has been sounding tired for three calls in a row. Minimal grounding (name, timezone) is sufficient.
- **No prior transcripts.** Per-call scope; cumulative observation happens via the agent's own existing-page updates over time. The agent's wiki *is* the cross-call memory.
- **No other agents' content.** Privacy invariant from `specs/agents-and-scope.md`.

### Output

```ts
{
  creates: Array<{
    title: string
    parent_slug?: string                 // typically the agent's root, defaults to root
    agent_abstract: string
    sections: Array<{
      title: string
      content: string                    // markdown, voice-readable not required (these aren't shown to user)
      snippets: Array<{ turn_id: string, text: string }>
    }>
  }>
  updates: Array<{
    slug: string                         // must match an existing agent-scope page for this agent
    agent_abstract: string               // regenerated
    sections: Array<{
      id?: string                        // existing section uuid — keep/update
      title?: string                     // for new sections
      content?: string
      snippets?: Array<{ turn_id: string, text: string }>
    }>
  }>
  skipped: Array<{ reason: string }>     // brief audit trail, no per-claim breakdown
}
```

### What's symmetric vs. simpler than user-scope

Symmetric:
- `creates` / `updates` / `skipped` top-level arrays
- Section keep/update/create/tombstone semantics (sections in DB but absent from `updates[].sections` get tombstoned)
- `agent_abstract` required on every create/update
- Snippet attribution via `turn_id`

Simpler than user-scope:
- **No Timeline section** — observations aren't subject to user-facing contradiction handling. If the user's behavior changes, the agent updates its observation in place (or appends a new note); no Timeline-style historicization.
- **No multi-target writes** — every observation lands on exactly one agent-scope page. No fan-out across pages.
- **No contradiction detection** — observations evolve naturally; old observations either get superseded by section content updates or persist as historical notes.

### Backend-injected fields

LLM never emits these — backend stamps from session context:
- `user_id` (from caller context)
- `scope='agent'`
- `agent_id` (active agent at ingestion time)
- All `id`s (UUID-generated)
- `created_at`, `updated_at` timestamps

Same security invariant pattern as user-scope.

---

## Backend commit pattern

Single Postgres transaction (per Chunk 2 of §11 transactional-commit idempotency):

```sql
INSERT INTO wiki_pages (
  ..., scope='agent', agent_id={active_agent.id}, agent_abstract, abstract, ...
)
INSERT INTO wiki_sections (...)
INSERT INTO wiki_section_history (..., edited_by='ai')
INSERT INTO wiki_section_transcripts (...)  -- per snippet
INSERT INTO wiki_log (kind='agent_scope_ingest', ref=transcript_id, ...)
```

`wiki_section_transcripts` is the same junction used for user-scope source attribution — its `section_id` resolves to a section whose owning page carries the scope discriminator.

`wiki_log` gets a new event kind `'agent_scope_ingest'`, distinct from existing `'ingest'` (user-scope), `'query'`, `'lint'`, `'task'`. Lets us audit agent-scope writes separately.

---

## Failure handling

- **Independent from user-scope.** User-scope fan-out can succeed while agent-scope fails (or vice versa). No dependency, no gating.
- **Conservative retry** per §11 Chunk 4: max 1–2 attempts, retry only on `RetryableError`, surface failures rather than silent retry.
- **No user-facing surface for failures.** Agent-scope is private internal notes; failures are Sentry-only with correlation IDs (per §11 Chunk 5 observability pattern).
- **Idempotency via transactional commit.** On retry, handler re-runs Flash call (low cost) and commits fresh. No checkpointing.

---

## Decision rules

### What's worth observing — three categories

The agent records three kinds of things:

1. **Behavioral patterns** — how the user communicates, decides, prioritizes ("user defers decisions when stressed," "tends to think out loud before committing")
2. **Recurring concerns / interests** — themes the user keeps returning to ("brings up Sarah frequently," "circling around career change for weeks")
3. **Stated preferences not yet promoted to user profile** — observations that don't yet warrant a `profile/preferences` entry but are useful color ("seems to dislike formal language," "responds well to direct questions")

NOT recorded:
- **Facts about the user's world** — those go to user-scope (Pro fan-out's job)
- **Things the user explicitly stated as fact** — "I lived in Boulder" is a user-scope claim, not an observation
- **Single-call low-substance ephemera** — "user yawned at minute 12" without anchoring substance
- **Content of *what* the user said** — observations are about *how* and *patterns*

### Skip-default — on substance, not repetition

The agent's private wiki **is the agent's only cross-call memory.** There's no other persistent context — each call's Flash sees exactly what's been written, nothing more. If an observation isn't recorded on first occurrence, it's effectively lost; no future call can recognize a "repeat" of something never written down.

So the discipline is:

- **Skip when low-substance** — trivial, vague, unanchored ("user seemed fine")
- **Skip when not an observation** — facts about the user's world go to user-scope
- **Record on first instance when substantive** — specific, anchored to call evidence, would inform future conversations
- **Subsequent calls evolve the record** — confirm patterns ("anxiety re: work — now seen across 3 calls"), refine understanding ("the work-anxiety is specifically about the reorg"), tombstone observations that turned out one-off

The bar is **substance + specificity**, not repetition. An observation worth keeping should be specific enough that a future call can either confirm or refine it.

### Where observations land

**Persona-specific seed pages.** Each persona's agent-scope subtree starts with a small seed structure (created at agent creation; see §10 onboarding seed):

For default Assistant:
- `assistant/observations` — general behavioral observations
- `assistant/recurring-themes` — what the user keeps circling back to
- `assistant/preferences-noted` — inferred preferences not yet user-confirmed
- `assistant/open-questions` — things the agent wants to explore in future calls

V1+ custom agents seed their own structure based on persona (Health Coach gets `wellness-patterns`, etc.).

**Auto-create vs. fixed pages — hybrid.** Observations land in seed pages by default. The agent MAY create new sub-pages under existing ones for emerging patterns warranting their own page (e.g., `assistant/recurring-themes/career-uncertainty` if it becomes a persistent thread). Heuristic: pattern referenced across ≥3 distinct calls + accumulated content exceeds ~500 words on the parent page. Below that, append to the parent's relevant section.

**No cross-page multi-target.** Each observation lands on exactly one page (per Chunk 1 — no multi-target writes). If the observation could plausibly land on two, pick the most-specific.

### Refresh vs. append discipline

Hybrid — append for new patterns, in-place update for refined understanding.

- **New observation → append.** New section or new bullet within an existing section. Preserves first-noticed timestamp via `wiki_section_history`.
- **Refined understanding → in-place section update.** When the agent sees the same pattern with new nuance, the section content gets updated (history preserved in `wiki_section_history`).

No Timeline section in agent-scope. If user behavior changes, the agent updates its observation; the change is captured in section history.

Agent can decide content format within a section. Markdown allowed but not required; bullets, paragraphs, terse tags — whatever the persona finds useful. Not user-facing.

### Source attribution — relaxed vs. user-scope

- **Substantive observations** (new pattern, specific behavioral note, anchoring quote) → attach `{turn_id, text}` snippet. Goes through `wiki_section_transcripts` junction at backend commit.
- **Light updates** that don't introduce new claims (e.g., "this pattern continues to hold") → no snippet required.

Snippets are optional per write — different from user-scope, where they're required on every content change. Observations are often gestalt-based; force-citing a single turn would mis-represent the basis.

### Persona-specific focus

The `persona_summary` field in input scopes what to observe. For MVP Assistant: a generic *"You are the user's general assistant. Observe productivity patterns, recurring themes, communication preferences, and shifts that would help future conversations be more useful."*

V1+ custom agents drive their own observation directives via persona_prompt. The persona scopes *what to notice*; scaffolding governs *how to write it*.

### Privacy + cross-scope discipline

Explicit reaffirmation in the prompt:

> *"You are writing to a private observation wiki visible only to you. Never reference user-scope facts directly. Never reference other agents' observations. Your observations are about the user's patterns, not the user's world."*

LLM never emits `agent_id`, `scope`, or any infrastructure fields — backend stamps from session context. Cannot fabricate cross-scope writes even if prompt is compromised.

Tombstone discipline matches user-scope: sections in DB but absent from the `updates` list get tombstoned. Agent can prune stale observations naturally over time. Tombstoned observations stay in `wiki_section_history` for audit.

### Skipped output

`skipped` array carries brief reasons. Examples:
- `"low-substance, no anchoring evidence"`
- `"user-scope fact, not an observation"`
- `"already captured in {existing_page} with no new nuance"`
- `"too speculative — would require fabrication to be specific"`

### Output volume guidance

Soft guidance in prompt:

> *"Most calls produce 0–2 observation writes. A long, content-rich call may produce 3–5. More than 5 is suspicious — you may be over-recording."*

Empty output is valid (short or pure-action calls). Server commits no rows; logs the empty-output event. No hard cap — soft guidance shapes the default; agent's judgment governs the actual count.

---

## Related decisions

- `specs/agents-and-scope.md` — multi-agent data model, per-agent partitioning, privacy invariants
- `specs/fan-out-prompt.md` — user-scope Pro fan-out (parallel pipeline)
- `specs/flash-retrieval-prompt.md` — user-scope candidate retrieval (no analog needed for agent-scope; full agent-wiki loads)
- `notes/ingestion-pipeline.md` — overall ingestion pipeline (user-scope-focused)
- `todos.md` §6 — agent-scope ingestion pass entry
- `todos.md` §4 — per-agent partitioning, agent-scope type set
