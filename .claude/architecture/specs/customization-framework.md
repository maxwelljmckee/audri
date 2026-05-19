# SPEC — Customization Framework + Sprint Scope Lockdown

Status: **decisions locked 2026-05-18** — sprint scope + customization architecture resolved in Socratic session following the v0.3.0 dogfood pass. **NL customization architecture locked 2026-05-19** (Open Question B closed; see dedicated section below). **Rumi (ingestion agent) surface locked 2026-05-19 → Option B** (knobs surface under Notes Settings). **Events sizing deferred to mid-sprint.** KnobSpec shape locked 2026-05-19.

**Naming note (2026-05-19):** the ingestion agent's internal name was workshopped during the KnobSpec session. Working name was "Rumi" (a placeholder during exploration); locked name is **Rumi** — chosen for fuzzy cultural reference (the 13th-century Sufi poet evokes deep wisdom + lyrical phrasing, fitting for an agent that rewrites notes) without being so well-defined culturally that there's no room to reinvent. The same heuristic — *strong but not over-defined cultural anchor* — should guide future agent names (Shakespeare, Plato would be too anchored; Audri/Rumi sit in the right zone).

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
2. **Agent-level tunable knobs** (Audri, Rumi, Dreams partial)
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

#### 1. Knob storage shape — global default with user override; agent-scope only

Knobs ship with a global default. Users override per their preference. Storage shape: per-agent JSONB on agents (defaults) + a `user_agent_settings` table (overrides) — exact schema deferred to implementation, but the conceptual contract is fixed.

**Scope-narrowing (locked 2026-05-19):** knobs are **agent-scope only**. App-level and page-level customization is handled exclusively by `user_custom_rules` (see § NL customization architecture below). Cross-scope knob composition would have required conflict resolution + scope-templated mutator endpoints + multi-source knob fetches at every inference site; the architectural simplification is large and the lost capability is minimal — every app/page knob candidate we considered (preferred timezone, page-private flag, etc.) is better-served by `user_settings`, an entity column, or an NL rule.

**Knobs reference agent TYPE, not agent name or ID.** New `agents.type` enum column (`'live' | 'ingestion' | ...`); KnobSpec `applies_to: AgentType[]` references the type. The user can rename their agent ("Audri" → "Steve") and the knob still applies because it's keyed to the type, not the name. Future custom-agent feature follows the same pattern.

**Why:** clean defaults mean we never have a user with an empty-state agent. Overrides mean any user can customize without our codebase changing. Per-user-without-defaults would have invited the "what does this knob do when unset?" mess at every inference site.

#### 2. Agent types in scope for v0.4.0 knobs

- **`type='live'` (Audri + future Live Agents)** — knobs on conversational style, verbosity, retrieval-eagerness, reasoning depth (mirrors Gemini Live API `reasoning_effort` config).
- **`type='ingestion'` (Rumi + future ingestion agents)** — knobs on output style (concise / faithful / structured / embellished). Builds on `project_style_knob_backlog` + agent_notes work; replaces today's hardcoded ingestion behavior.
- **Dreams** — no general "agent power" knob (reasoning depth is structurally tiered as Light / REM / Deep). Future knobs (proposal-frequency, intervention-aggression) — out of v0.4.0 scope.

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

1. **Build for one agent end-to-end first.** Live Agent goes first (most prompt surfaces, hardest semantics). Refactor it cleanly, prove the seam holds, *then* port Rumi and Dreams. Designing across all three in abstract produces a generic abstraction that fits none of them.
2. **Behavioral test before refactor.** Capture 3-5 real input/output pairs from current Live Agent covering: capture turn, lookup turn, agent_notes-directed enrichment, refusal/clarify. Replay post-refactor. Equivalent outputs ≈ no semantic drift.
3. **Budget honestly.** This is the most invisible-progress work in the sprint. Plan it as a full week; the rest accelerates after, and silent prompt drift across every agent is the worst failure class.

---

## NL customization architecture (locked 2026-05-19)

Locked through Socratic workshop 2026-05-19. The architecture below covers the NL-rules layer end-to-end: storage, scope, write paths, enforcement, and integration with the existing knob substrate. Closes Open Question B from the original spec draft.

### Two-layer recap

Customization runs as **typed knobs (substrate) + free-form rules (overlay)**. Knobs handle deterministic, enumerable settings injectable anywhere (prompt tokens, SQL filters, UI density). Rules handle the long tail of natural-language guidance ("always cite your sources", "on this list, include author + year") injected at LLM-inference sites only. The two coexist; rules don't preclude knob proposals (see Dream distillation in §1 LD3 above).

### Locked decisions

#### 1. Storage shape — dedicated `user_custom_rules` table

```sql
user_custom_rules (
  id              uuid primary key,
  user_id         uuid not null references auth.users,
  scope           enum('app', 'agent', 'page', 'plugin'),  -- 'plugin' reserved, not wired in v0.4.0
  agent_id        uuid nullable references agents,         -- required when scope='agent'
  wiki_page_id    uuid nullable references wiki_pages,     -- required when scope='page'
  plugin_id       text nullable,                            -- required when scope='plugin' (reserved)
  content         text not null,                            -- markdown rule text
  source          enum('user_set', 'dreams_proposed'),     -- authorship origin
  dream_id        uuid nullable references dreams,         -- FK when distilled from a Dream proposal
  is_active       boolean default true,                    -- disable-without-delete
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
)
```

CHECK constraints enforce the scope→FK shape (`scope='agent' → agent_id IS NOT NULL` etc.). Indexes on `(user_id, scope)` + scoped FK partial indexes. RLS predicates per scope (page-scope inherits page RLS; agent-scope inherits agent RLS; app-scope owner-only).

**Note on naming overlap:** `wiki_pages.scope` exists with values `'user' | 'agent'` (user-vs-agent partitioning) — a different concept from `user_custom_rules.scope`. The collision is conceptual not literal (different tables, different value spaces). A code comment on the column documents the distinction.

#### 2. Scope hierarchy

Four scopes (one reserved):

| Scope | Example | When it applies |
|---|---|---|
| **app** | "Always cite sources." "No emojis." | Cross-cuts every agent + plugin. Read by every inference site. |
| **agent** | "Audri should be terse." | Per-agent customization. Read by inference sites running on behalf of that agent. |
| **page** | "On this list, always include author + year." | Per-wiki-page conventions. Read when an inference touches that page. |
| **plugin** *(reserved)* | "In Todos, default to grouping by project." | Plugin-level defaults. Not wired in v0.4.0; enum value reserved for forward compatibility. |

#### 3. Conflict resolution — concat + LLM composes

All relevant rules for an inference get concatenated into the Behavioral layer of the prompt, **ordered by specificity** (page > agent > app). Header signals precedence: *"More specific rules override broader ones."* The LLM does the composition — we do NOT build a structural conflict-detection subsystem.

**Drift risk** mitigated by: (a) read-only knob/rule inspection UI exposes accumulated rules per scope; (b) Dreams pattern-detection observes when rules pile up or stop being load-bearing.

#### 4. Live Agent stays read-only — App Map informs, never writes

Live Agent's role in customization flows:

1. Reads the **App Map** (capability descriptions, including knob enumeration and existing custom rules).
2. When the user expresses a customization intent ("be more terse"), Live Agent identifies whether it maps to a known knob value, an existing rule, or a candidate new rule.
3. **Clarifies + confirms** the user's intent verbally, including scope ambiguity ("do you mean across all agents, just Audri, or just for this conversation?").
4. **Never invokes a mutation tool.** Live Agent has no `set_knob` / `set_rule` write tools.

The verbal confirmation lands in the transcript. The settings specialist (§5) captures it during ingestion.

#### 5. Settings specialist owns the writes

A new specialist handler — mirrors the Todo specialist concept and the broader "specialist tail" direction (v0.3.0 #98). Responsibilities:

- Parses settings directives from the transcript (or a transcript slice).
- For directives matching a known knob: writes the typed value to `user_agent_settings` (or analogous knob storage).
- For directives not matching a knob: writes the rule text to `user_custom_rules` with the appropriate scope + FKs.
- Fuzzy-match heuristic for knob-name detection — accepted; structured-output specialist resolves ambiguity.

**Pro fan-out stays focused on notes ingestion.** Settings-mutation responsibility is split off entirely; no §"Settings directives" clause added to Pro's prompt. Keeps Pro narrow and prevents prompt dilution (matches the rationale for the deferred Pro-fork backlog entry).

#### 6. Pre-Pro helper + fast-path routing

Settings detection runs as a **pre-Pro helper in parallel** with Pro fan-out (same architectural pattern as `enrichment-lookup.ts`, locked in `project_pre_pro_pipeline_pattern` memory). The traffic director gains a fourth branch:

| Branch | Path |
|---|---|
| **empty** | Heuristic bypass; no inference. |
| **task-only** | Skip Pro; route directly to Todo specialist. |
| **settings-only** | Skip Pro; route directly to settings specialist. |
| **standard** | Pre-Pro helpers (settings detection + enrichment lookup) fire in parallel; Pro fan-out processes the rest as notes. |

For mixed transcripts on the standard path: settings specialist commits **out of band** — independent transaction, parallel write, no shared atomicity with Pro's commit. Different tables, no FK dependency. Worst-case failure mode (one path commits, the other doesn't) is recoverable by the user re-stating in the next call; the verbal-confirmation loop in §4 means the user already knows what they asked for.

#### 7. Single App Map — no layered rendering

Plugin registry is the SOT. **One App Map** generated from it; both Live Agent and ingestion specialists consume the same map. The ingestion-side fields (`mutator_endpoint`, `api_config` per value) add ~3 lines per knob — not enough to warrant two rendering layers. Live Agent's prompt instructs it to ignore the backend-config fields it doesn't need.

**Updated from earlier draft (2026-05-19):** initial design called for two views (capabilities-only for Live, capabilities+endpoints for ingestion). Concrete KnobSpec examples revealed the field overlap is dominant; the extra fields don't justify duplicated rendering pipelines.

#### 8. Page rule join + scoped fetches

Page-scoped rules ride along **for free** via the existing Flash candidate retrieval — Flash pulls candidate pages with their associated rows; we add a join on `user_custom_rules WHERE scope='page' AND wiki_page_id IN (...)`.

App + agent rules don't piggyback on candidates; fetched separately at ingestion-task start:

- 1 query: `WHERE scope='app' AND user_id=? AND is_active=true`
- 1 query: `WHERE scope='agent' AND user_id=? AND agent_id=? AND is_active=true`
- Page rules: via Flash candidate join (free)

Three rule sources, two extra queries. Negligible cost; high architectural clarity.

#### 9. Scope-clarification has pedagogical value, not friction

When scope is ambiguous, Live Agent explicitly asks the user. *"Do you want that to apply to the whole app, this particular agent, or just this page?"*

This isn't a chatty cost — it's **gentle scaffolding that teaches users the system shape** and trains them to use scope-aware language proactively in future calls. Per Core UX principles: **Autonomy** (user choice), **Transparency** (user sees the surface), **Control** (user sets the scope). When user intent is unambiguous, Live Agent commits silently with a terse confirmation; only the genuinely-ambiguous cases trigger clarification.

#### 10. UI / system preferences housed separately

Non-AI preferences (mic sensitivity, future theme picker, notification toggles) have a structurally different shape:

| | NL rules (`user_custom_rules`) | UI/system prefs |
|---|---|---|
| Shape | free-form text | typed (bool/enum/number) |
| Scope | hierarchy | user-level only |
| Conflict resolution | precedence-ordered | none |
| Write path | ingestion-mediated | direct UI write |
| Live Agent awareness | yes (App Map) | no |

UI prefs extend the existing **`user_settings` table** (already used for `onboarding_complete`, etc.) for cloud-synced values, or live in AsyncStorage for genuinely ephemeral ones (last-viewed timestamps, etc.). No new `user_preferences` table.

#### 11. agent_notes column scrapped + re-dogfooded; Rumi becomes a real agent row

Three coupled changes:

**A. Drop `wiki_pages.agent_notes` (no data preservation).** v0.3.0 shipped this column 2026-05-18 as the page-scoped NL substrate prototype. Under the new architecture it's superseded by `user_custom_rules` scope='page'. Blast radius is one user; clobbering the day-old data is cheap and avoids designing a one-shot migration.

**B. Add `agents.type` enum column.** New `agent_type` enum (`'live' | 'ingestion'` initially; extends later as `dream`, `todo`, etc. land). Column is NOT NULL after backfill. Existing default-Assistant rows backfill to `type='live'`.

**C. Seed Rumi (`type='ingestion'`) agent row per user.** New rows seeded at signup; backfill migration creates one for the existing user. Internal name `'Rumi'` (locked 2026-05-19 — see naming-rationale note at top of spec). The row exists as substrate for: (a) `user_agent_settings` knob storage keyed to this `agent_id`; (b) page-scoped + agent-scoped `user_custom_rules` rows pointing at this row when Rumi-specific. Per Open Question A → Option B, the row does NOT surface in the Agents tile UI.

**Full migration sequence:**

1. Add `agent_type` enum + `agents.type` column (NOT NULL default backfilled).
2. Backfill existing Assistant rows → `type='live'`.
3. Seed an `type='ingestion'` agent row per existing user (single user — Max).
4. Update signup flow to seed both `live` (Audri) and `ingestion` (Rumi) agent rows on user creation.
5. Add `user_custom_rules` table + RLS + realtime publication.
6. Add `user_agent_settings` table (knob overrides) + RLS.
7. Drop `wiki_pages.agent_notes` column.
8. Update `apps/worker/src/ingestion/enrichment-lookup.ts` to scan `user_custom_rules WHERE scope='page' AND wiki_page_id=? AND is_active=true`.
9. Update Pro fan-out read site to consume joined-in page rules + fetched app/agent rules (where `agent_id` = the call's ingestion agent, found via `kind='ingestion'`).
10. Update Live Agent `fetch_page` + preload to read from new table.
11. Re-run the book-reading-list dogfood flow (yesterday's test case) against the new path.

**Ingestion-prompt-storage decision deferred.** Today the ingestion prompt is hardcoded in `pro-fan-out.ts`. With Rumi as an agent row, an argument exists for moving the prompt into `agents.persona_prompt`. **Deferred to the Track A prompt decomposition work** — the prompt-decomposition seam (layer naming) will determine where Rumi's prompt content lives. For v0.4.0 the row exists for knob/rule binding; the prompt stays where it lives today.

### Locked KnobSpec v2 shape

Refined through example-driven workshop 2026-05-19 (Rumi Writing Style + Audri Reasoning Depth examples). For v0.4.0:

```typescript
type KnobSpec = {
  name: string;                              // snake_case identifier
  display_name: string;                      // UI label
  description: string;                        // user-facing explanation
  applies_to: AgentType[];                    // agent types (e.g., ['live'], ['ingestion'])
  type: 'enum' | 'boolean';                   // v0.4.0: enum + boolean only; number/string deferred
  kind: 'prompt' | 'api_config';              // how the value is consumed downstream
  values: KnobValueSpec[];                    // per-value content
  default: string | boolean;
  mutator_endpoint: string;                   // PUT endpoint template with :agent_id placeholder
  user_visible: boolean;                      // hide internal-only knobs from settings UI
};

type KnobValueSpec = {
  value: string | boolean;
  display_name: string;
  description: string;
  match_hints?: string[];                     // example user phrases that map to this value (for Live Agent fuzzy match)
  prompt_injection?: string;                  // required when knob.kind === 'prompt'
  api_config?: Record<string, unknown>;       // required when knob.kind === 'api_config'
};
```

**Validation requirement (implementation):** runtime + schema-level validator enforces `kind` → value-shape coherence (prompt knobs must have `prompt_injection` on every value; api_config knobs must have `api_config`). A misconfigured knob silently no-ops without this.

**Number + string types deferred.** v0.4.0 ships enum + boolean only. Number knobs add when a concrete use case appears (likely candidates: call duration soft-cap, REM recency window — see § 1 LD2 above). String knobs are deliberately out — free text belongs in `user_custom_rules`, not knobs (boundary: structured = knob; expressive = rule).

**Multi-value knobs (multi-enum) deferred.** v0.4.0 prefers multiple booleans over multi-enum types for the rare cases where multi-select makes sense. Promote to multi-enum when the UI cost feels real.

### Held for dedicated workshop passes

- **Specific knob enumerations** for `live` and `ingestion` agent types — drafted at implementation time once the prompt-decomposition seam lands.
- **Settings specialist prompt** — drafted at implementation time.
- **App Map rendering format** — concrete JSON shape drafted at implementation time.

---

## Onboarding deferral

Onboarding is moved to the END of v0.4.0, after all scope is finalized and exercised. Continued onboarding investment is wasted while service catalog + capability set are still moving. (Memory rule: new plugins normally trigger an onboarding pass; that rule is **explicitly suspended** for the duration of this sprint, then resumed with a single batch pass at sprint close.)

---

## Open questions (for follow-up)

These are NOT punts — they're flagged for explicit follow-up discussion before implementation:

### ~~A. Rumi's user-facing surface~~ — LOCKED 2026-05-19: Option B

**Decision:** Rumi stays an **internal name**; its knobs and settings surface inside **Notes Settings** (per-plugin settings cog), not as a first-class agent in the Agents tile.

**Reasoning:** exposing Rumi as a named agent would compound the user's learning curve and inflate the visible agent inventory before users have a strong mental model of what each agent does. Simplicity wins for the launch; the "Rumi as full persona" idea is deferred as a candidate A/B experiment for later, once users have a baseline relationship with Audri + (eventually) custom agents.

**Implementation implication:** the Track D Agents tile work in v0.4.0 does NOT include a Rumi entry. Rumi's knob UI lands inside the Notes plugin's settings-cog drawer (Track B per-plugin settings cog → Notes-specific drawer contents).

### ~~B. Full NL customization architecture~~ — LOCKED 2026-05-19

Resolved via dedicated Socratic workshop 2026-05-19. See § "NL customization architecture (locked 2026-05-19)" above for the full set of locked decisions (storage shape, scope hierarchy, write paths, enforcement surfaces, agent_notes migration plan, etc.). 11 decisions locked; 3 sub-questions held for dedicated workshop (KnobSpec shape, settings specialist prompt, App Map layered rendering format).

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

- **KnobSpec shape in plugin registry** — held for dedicated workshop (next).
- **Specific knob enumerations per agent** — defined at implementation time once prompt decomposition seam is fixed.
- **Settings specialist prompt** — drafted at implementation time.
- **App Map layered rendering format** — drafted at implementation time.
- **Settings UI visual design** — drafted at implementation time once Notes Settings drawer scaffold lands.
- **Events data model** — separate spec when Track E execution begins.
