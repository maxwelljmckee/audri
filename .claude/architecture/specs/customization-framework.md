# SPEC — Customization Framework + Sprint Scope Lockdown

Status: **decisions locked 2026-05-18** — sprint scope + customization architecture resolved in Socratic session following the v0.3.0 dogfood pass. NL customization details + Scribe surface flagged open below.

Two intertwined deliverables captured here:

1. A **scope-narrowing decision** for the coming sprint (v0.4.0): three plugin surfaces only — Notes, Todos, Schedule. Storage / Research / Automations are scaffolded but hidden.
2. A **customization framework** spanning agent-level knobs + an NL overlay, with prompt decomposition as the foundational refactor.

Companion to `agents-and-scope.md` (per-agent persona model), `conversational-routing.md` (intra-call style modulation), `build-phases/v0.3.0.md` (the sprint we're closing), and the eventual `build-phases/v0.4.0.md` (which this spec gates).

---

## How we got here — scope-narrowing rationale

**The trigger.** Today's v0.3.0 dogfood pass on the Pro fan-out ingestion pipeline surfaced a recurring lesson: every plugin surface carries a *world* of nuance underneath it. Single-day examples: silent drops from prompt-pattern lock-in (`feedback_prompt_data_isolation`), schema-vs-prompt enforcement asymmetry (`feedback_schema_beats_prompt`), the named-entities-always overcorrection (`feedback_proactive_stub_overcorrection`), the pivot from Live-Agent-side grounding to a worker pre-Pro pipeline (`project_pre_pro_pipeline_pattern`). Each iteration revealed depth that wasn't visible from the outside.

**The extrapolation.** If one plugin surface (notes ingestion) needs this depth of iteration to feel bulletproof, attempting parallel depth on 6+ surfaces in MVP+1 will result in shallow output everywhere. The product premise is **deep at the foundation, expand outward** — not breadth-first.

**Pass 1 (already done).** Earlier in v0.3.0 planning we deferred external connectors (Gmail, etc.) from core MVP. That decision stands.

**Pass 2 (this spec).** Within the remaining feature set, narrow further. For v0.4.0 ship three plugin surfaces: **Notes, Todos, Schedule**.

### Why these three

- **Notes** — the gravity well. The wiki graph that ingestion builds is what every other plugin reads from or writes to. Investing further in Notes (knobs, output styles, per-page conventions) compounds across every other surface. Foundational, not optional.
- **Todos** — the natural user-facing payoff of the notes graph. "What should I do?" is the most direct value extraction. Substrate already exists; specialist agent + UX maturity is the gap.
- **Schedule (Events)** — time-bound entity distinct from todos. Aligns with users' existing mental model of *task* vs. *event*. ICS calendar subscriptions are extremely cheap to integrate and unlock the "what's coming up this week" surface with minimal lift.

### Why defer Storage / Research / Automations (UI surface)

These three are **supportive** to the knowledge base rather than carriers of distinct upfront value:

- Storage / Uploads: feeds the graph; doesn't pay rent at the UX surface yet.
- Research: a plugin user *triggers*, not a primary daily-use surface.
- Automations (UI tile): the cron-shaped surface most users won't directly configure.

**The deferral is UX-only, not substrate.** Plugin registry entries, schema tables (`research_outputs`, future `uploads`), the agent_tasks dispatcher, and the activity stream all stay live. Capability advertisements drop from the Live Agent prompt; UI tiles hide; nothing rips out.

### Dreams pulled in as Automations subservice

Dreams is architecturally an Automations subservice (CRON-driven Light/REM/Deep tiers — see `project_dreams_architecture`). The Automations *tile* stays hidden in v0.4.0, but Dreams gets read/configure surface inside the Agents tile so users can interact with it. This pull-in is mandatory because Dreams powers the proactive-customization loop (§ NL → knob distillation below).

---

## Sprint order (v0.4.0 rough sequencing)

In order:

0. **Quick wins** (ingestion traffic director — see § Quick Wins below)
1. **Prompt decomposition / recomposition** (foundational refactor)
2. **Agent-level tunable knobs** (Audri, Scribe, Dreams partial)
3. **NL customization layers** (overlay on knobs)
4. **Todo specialist** (agent maturity for the Todos surface)
5. **Events end-to-end** — second sprint; sizing dictates split (see Open Questions)
6. **App Map** — merged into plugin registry rather than separate (see § App Map)
7. **Onboarding pass** — last, post-scope-lockdown (see § Onboarding deferral)

---

## Quick Wins

Cheap, high-leverage items shipped at the front of the sprint. The bar: small surface area, no architectural commitment, observable user-facing improvement (cost / latency / reliability).

### Ingestion traffic director

A thin **deterministic routing layer at the top of the ingestion pipeline**, BEFORE Flash retrieval and Pro fan-out. Routes each transcript to one of N downstream paths based on lightweight classification.

**The problem.** Empty / trivial transcripts ("hey just testing," hang up without speaking, single-word utterances) currently fire the full pipeline — Flash retrieval, Pro fan-out, agent-scope ingestion — and have been observed to hang and fail loudly. Wasted compute, wasted latency, and a class of false-failure noise that obscures real signal.

**Architectural shape.** Same pattern as `project_pre_pro_pipeline_pattern`: deterministic routing decision in the worker, BEFORE LLM inference. The router itself may use a cheap Flash-tier classifier (single inference, structured output) but it does NOT loop and does NOT have tools.

**Branches (initial set):**

1. **Empty bypass** — pure heuristic (word count, ASR confidence, duration). No inference. Skip all downstream services; mark transcript as `empty` / `noop`.
2. **Task-only fast path** — Flash classifier flags `route: task_only` with extracted intents (e.g. "add todo: email Sarah"). Skip Pro fan-out entirely; route directly to action dispatcher for todo creation.
3. **Standard path** — current pipeline. Flash candidate retrieval → Pro fan-out → commit. Default route; bias toward this when uncertain.

**Extensibility.** Designed as a simple conditional dispatch so adding new branches is mechanical. Future candidates: pure-note path (notes only, no task), schedule-only path (calendar entry creation), etc.

**Asymmetric failure cost — bias toward standard.** Routing to `task_only` when the transcript ALSO had notes content = silent information loss (bad). Routing to `standard` when it was actually task-only = wasted inference cost (cheap). Classifier must overshoot the safe path under uncertainty.

**Telemetry is mandatory.** Every routing decision emits a typed event with `{route, confidence, transcript_length, classifier_latency_ms}`. The branch-distribution data informs future decisions including the deferred Pro-fork question (see Open Question D below).

**Pairs with:** the existing P1 backlog item "Application-level wall-clock timeout on Gemini fan-out calls" (the long-tail Pro hangs the router won't catch). Both should land in v0.4.0 quick-wins.

---

## Customization architecture

### Two-layer model

Customization runs as **structured knobs (substrate) + natural-language rules (overlay)**:

| Layer       | Shape                                 | Enforcement surfaces                                            | Distillation                                              |
| ----------- | ------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| Knobs       | Typed, finite, enumerable             | Anywhere — prompt token injection, SQL filters, UI density      | —                                                         |
| NL overlay  | Free-form text, scoped                | LLM-inference surfaces only (prompt injection at relevant site) | Dreams observes repetition → proposes knob change         |

The layering resolves the storage tension surfaced earlier in this session: knobs give us auditability, enforcement at non-LLM surfaces, and a sane settings UI; NL gives us long-tail expressiveness and the "I don't know which knob to turn" escape hatch.

### Locked decisions

#### 1. Knob storage shape — global default with user override

Knobs ship with a global default. Users override per their preference. Storage shape: per-agent JSONB on agents (defaults) + a `user_agent_settings` table (overrides) — exact schema deferred to implementation, but the conceptual contract is fixed.

**Why:** clean defaults mean we never have a user with an empty-state agent. Overrides mean any user can customize without our codebase changing. Per-user-without-defaults would have invited the "what does this knob do when unset?" mess at every inference site.

#### 2. Agents in scope for v0.4.0 knobs

- **Audri (Live Agent)** — knobs on conversational style, verbosity, retrieval-eagerness.
- **Scribe (Ingestion Agent)** — knobs on output style (faithful / concise / embellished / embellished+context). Builds on the `style_knob_backlog` memory + today's work on agent_notes.
- **Dreams** — no general "agent power" knob, because reasoning depth is already structurally tiered as Light / REM / Deep. Knobs that *do* apply (e.g. proposal-frequency, intervention-aggression) are in scope.

#### 3. NL → knob distillation drives the proactive loop

When a user repeatedly corrects an agent in a consistent direction ("be more terse," "stop summarizing"), Dreams observes the pattern and proposes a knob change. The user accepts (one-time) and the knob updates globally.

This is the **proactive customization UX** in concrete form. It's also why Dreams is mandatory in this sprint.

#### 4. Per-plugin settings cog (UX surface)

Every plugin surface gets a settings-cog in the upper-right corner of its UI, mirroring the app-level home-screen settings affordance. Available configs vary by context (plugin's knob set + relevant agent knobs).

#### 5. App Map merged into plugin registry

No separate App Map surface. The plugin registry already carries capability descriptions, schemas, and prompt fragments. The "App Map" concept — a generated artifact describing all available features for Live Agent advertisement (and possibly Dreams recommendations) — is a **view over plugin registry**, not a parallel source of truth.

**Why:** two SOTs drift. One source, multiple consumers.

#### 6. Dreams as Automations subservice; surfaced via Agents tile

Dreams stays an Automations subservice architecturally. UX-wise, the Automations tile remains hidden in v0.4.0; Dreams gets a read/configure surface inside the Agents tile so users can see what Dreams is doing and adjust its behavior. When Automations tile lights up (post-v0.4.0), Dreams' canonical home migrates there.

### Prompt decomposition contract

The foundational refactor. All other customization work assumes a clean prompt-composition seam.

#### Layer naming (locked)

A prompt is composed from discrete layers, each with a defined source:

1. **Identity / role** — who the agent is. Static, per-agent.
2. **Capability advertisement** — what the agent can do. Generated from plugin registry (see App Map merge above).
3. **Behavioral** — knobs + active NL overlays. Injected per inference.
4. **Contextual** — per-call / per-page / per-task data. Dynamic, request-specific.
5. **Grounding** — retrieval results, enrichment lookups, tool outputs. Injected post-retrieval.

Each layer has exactly one injection point and one source of truth.

#### Implementation discipline

1. **Build for one agent end-to-end first.** Live Agent goes first (most prompt surfaces, hardest semantics). Refactor it cleanly, prove the seam holds, *then* port Scribe and Dreams. Designing across all three in abstract produces a generic abstraction that fits none of them.
2. **Behavioral test before refactor.** Capture 3-5 real input/output pairs from current Live Agent covering: capture turn, lookup turn, agent_notes-directed enrichment, refusal/clarify. Replay post-refactor. Equivalent outputs ≈ no semantic drift.
3. **Budget honestly.** This is the most invisible-progress work in the sprint. Plan it as a full week; the rest accelerates after, and silent prompt drift across every agent is the worst failure class.

---

## Existing `agent_notes` migration story (open)

We shipped `wiki_pages.agent_notes` in v0.3.0 as the page-scoped NL substrate. Once the broader NL customization layer ships, page-scoped NL rules are one slice of that layer. Three possible resolutions:

1. **Absorb** — agent_notes becomes one storage type within the unified NL system.
2. **Coexist** — agent_notes stays as the page-scoped slice; system-level NL is a parallel store.
3. **Refactor / rename** — preserve the data, surface it under a unified API.

Decision deferred — gated on clearer view of the overall NL customization architecture.

---

## Onboarding deferral

Onboarding is moved to the END of v0.4.0, after all scope is finalized and exercised. Continued onboarding investment is wasted while service catalog + capability set are still moving. (Memory rule: new plugins normally trigger an onboarding pass; that rule is **explicitly suspended** for the duration of this sprint, then resumed with a single batch pass at sprint close.)

---

## Open questions (for follow-up)

These are NOT punts — they're flagged for explicit follow-up discussion before implementation:

### ~~A. Scribe's user-facing surface~~ — LOCKED 2026-05-19: Option B

**Decision:** Scribe stays an **internal name**; its knobs and settings surface inside **Notes Settings** (per-plugin settings cog), not as a first-class agent in the Agents tile.

**Reasoning:** exposing Scribe as a named agent would compound the user's learning curve and inflate the visible agent inventory before users have a strong mental model of what each agent does. Simplicity wins for the launch; the "Scribe as full persona" idea is deferred as a candidate A/B experiment for later, once users have a baseline relationship with Audri + (eventually) custom agents.

**Implementation implication:** the Track D Agents tile work in v0.4.0 does NOT include a Scribe entry. Scribe's knob UI lands inside the Notes plugin's settings-cog drawer (Track B per-plugin settings cog → Notes-specific drawer contents).

### B. Full NL customization architecture

Question 6 from the workshop ("agent_notes migration story") and a clear view of the NL layer's storage / enforcement model are still open. Once NL architecture is fleshed out, we can decide how `agent_notes` fits.

### C. Events sizing — one sprint or two

Events end-to-end = ICS subscription ingestion + per-event entity model + linking events to existing wiki pages ("dinner with Alex" → Alex page) + UI surface + briefing/notification integration. Comparable in scope to the entire Todos plugin. **Decision deferred to mid-sprint (2026-05-19):** revisit when we reach Track E in execution — Tracks A–D will inform whether Events fits inside v0.4.0 or warrants its own v0.4.1 carve-out.

### D. Pro fan-out fork into Notes + Task Dispatch (DEFERRED → backlog)

Proposal floated 2026-05-19: split the Pro fan-out into two specialized inference passes — one for note/wiki writes, one for action dispatch (todo creation, etc.) — coordinated with the Todo specialist work.

**Deferred for now**, parked in backlog. Reasoning:

- Most real calls have interleaved notes + tasks; forking forces a non-trivial coordination model (parallel? sequential? shared Flash candidates? cross-references?).
- Today's Pro sees the whole transcript and can decide that "email Sarah" should reference an existing Sarah page; split Pro inferences each see partial context and risk losing the connection.
- It would be solving an unmeasured problem. The traffic director's routing telemetry (Branch 2 vs Branch 3 distribution) will tell us empirically what fraction of calls are task-dominant, notes-dominant, or mixed. Decision should be data-driven.

**Revisit trigger:** when traffic-director telemetry shows a meaningful skew (e.g., >40% of standard-path calls turn out to be predominantly one shape or the other) OR when Todo specialist work surfaces concrete pain at the unified-Pro layer.

---

## What this spec does NOT cover

- Specific knob enumerations per agent (defined at implementation time once prompt decomposition seam is fixed).
- Settings UI visual design.
- NL rule storage schema (gated on Open Question B).
- Events data model.
- v0.4.0 sprint-doc rearrangement (follows once this spec is finalized).
