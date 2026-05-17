# Audri — Backlog

Things we plan to do but deferred out of MVP. Centralized here so we don't lose track as we pile "do this later" notes into `todos.md` and `tradeoffs.md`.

Each entry is sortable by **Priority**, **Effort**, and **Type**. Not a commitment of order or timing — just a structured snapshot of the post-MVP horizon.

---

## Legend

**Priority** (urgency once MVP ships)
- **P0** — V1 first wave; highest priority post-MVP
- **P1** — V1, likely inclusion
- **P2** — V1+ beyond; triggered by observed need
- **P3** — Nice-to-have; maybe never

**Effort** (rough size)
- **S** — < 1 day
- **M** — 1–3 days
- **L** — ~1 week
- **XL** — multi-week

**Type** — Feature / Infra / Data model / UX / Observability / Security / Cost-Business / KG maintenance / Tech debt (often combined when an item spans categories)

---

## Open post-MVP cleanup

Items from the original "Currently outstanding (post-MVP-launch)" snapshot that are still in motion. Closed entries from that snapshot live in `backlog-archive.md` under "Shipped".

- ⏺️ **Mobile Sentry source-map upload** — secrets set, not yet validated end-to-end (will confirm on first prod crash). Detailed entry under Infrastructure → Environments.
- 🔵 **PostHog feature flags** — wiring in progress 2026-04-29. Detailed entry under Infrastructure → Observability expansion.
- **Vitest test runner + cross-agent leakage tests** — scaffolds exist (`apps/server/src/__tests__/rls-leakage.test.ts`); install + wire in V1. Manual smoke tests + service_role bypass architecture mean leakage is structurally hard at MVP scale.
- **Service environment splits** (Supabase dev/prod, Render staging) — punted to V1+ 2026-04-29. Detailed entries under Infrastructure → Environments.

---

## Prompt engineering — parked architectural reference

The architectural note below sat alongside an active 8-item prompt-engineering tranche that moved into `build-phases/v0.3.0.md` (Track A2 ingestion + A3 research) on 2026-05-12. Note retained as a future-tranche reference; new prompt-engineering items accumulate here.

### Architectural note — consider conditional prompt routing before scoping a tranche

As this list grows (conversational modes, research modes, ingestion-mode hints, principle-naming, hierarchy clauses), the temptation will be to keep stacking everything into the single 7-layer system prompt the composer assembles at call start. That's a path to a bloated, contradictory mega-prompt where every clause has to caveat itself for every other situation, and where caching efficiency degrades because every variant lives in one big string.

**Before promoting a tranche to a build phase, decide whether to introduce a conditional prompt routing layer first.** The shape might look like one of (or a combination of):

1. **Predicated prompt clauses** — each layer in `composeSystemPrompt` declares a condition predicate; the composer evaluates predicates at compose time and includes only matching clauses. Today's layers are unconditionally included. Cheap to introduce; works for static conditions (call_type, agent persona, presence of incomplete-call context). Doesn't help with mid-call shifts.
2. **Pre-classifier pass at session start** — a fast Flash call before composing the prompt classifies the situation (mode, user state, likely intent, maybe even "this looks like brainstorm vs dictation"). Composer reads the classification and assembles a tighter, mode-specific prompt. Costs an extra LLM hop; saves tokens on every subsequent turn; pairs with explicit caching.
3. **Per-mode cached prompt prefixes** — each mode (call_type × conversational mode × scope) is its own pre-baked, cached prompt prefix. Switching modes = switching cache prefixes, paying re-prime cost once. Cleanest cache story but combinatorial explosion of variants if not bounded.
4. **Tool-driven mid-flight shifts** — agent invokes a `set_mode(mode)` tool when it senses a context change; runtime swaps in the matching scaffolding chunk for the next turn. Works mid-call but introduces mode-flapping risk + observability complexity.
5. **Hybrid (likely answer)** — universal top-level scaffolding (always-on), predicated modules (loaded by condition at compose time per #1), per-mode cache prefixes for the heavy seed modes per #3, tool-driven shifts per #4 only where mid-call mode change is genuinely useful (e.g. brainstorm ↔ dictation).

**Open questions to resolve before any code:**
- Cache TTL impact — explicit caching is already core to cost strategy; routing changes affect cache hit rate.
- Classifier cost vs. mega-prompt token cost — break-even point depends on session length.
- Deterministic vs probabilistic mode choice — if the classifier or the model itself picks the mode, how do we make that visible/auditable to the user (Transparency principle)?
- Debug/observability — at MVP we can read the composed prompt off the call_transcripts row; routed prompts need similar logging without leaking persona-prompt-protected fields.

Revisit this note *before* a new prompt tranche is promoted to a build phase. If the answer is "yes, route first," the routing infra becomes the first item in that phase and the prompt-content items hang off it. If the answer is "no, lump it for now," fine — but capture the rationale + the trigger condition that would make us reconsider.

### Live Agent prompt

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| **Conversational Routing — Phase 2 telemetry (deferred pending framework stabilization)** | **P2** | **M** | **Feature + Infra (observability)** | Originally scoped for v0.3.0 as one of: (i) tool-call ride-along (`set_turn_intent` registered alongside the new read tools, persists into transcript JSONB); (ii) post-hoc Flash classification at ingestion time. **Returned to backlog 2026-05-13** after recognizing the underlying Conversational Routing framework was demoted from explicit "if A then persona B" routing to a set of suggestions + multi-shot examples in the system prompt — there's no longer a discrete persona-decision per turn to capture. If we re-harden the routing framework later (e.g. usage patterns reveal misrouting that fluid guidance can't fix), revisit this telemetry work alongside that hardening. Source: 2026-05-13 v0.3.0 kickoff Q&A. |

---

## Features

### Interaction modes

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Ask mode | P2 | M | Feature | Short-question/short-answer path, lighter than full Call. Entry from anywhere in the app. Source: §9. |
| Note mode | P2 | M | Feature | Voice-to-transcript-to-KG bypassing dialogue. Shares ingestion pipeline. Source: §9. |
| **Interactive Call Surface (ICS)** — agent-driven UI in-call | **P0 (foundational)** | **XL** | **Feature + Infra (architectural direction)** | **Not a single feature; a foundational substrate that future capabilities will live inside.** Today's call screen is a passive audio-visualizer. ICS is the pattern where Gemini Live tool-calls each have BOTH a server-side handler AND a registered client-side renderer that mounts in a live in-call pane (drawer, in-app browser, canvas). The orb stays on top; everything else (connector OAuth, fetched preview, on-the-fly chart, mid-call artifact draft) renders in a region the agent can drive. Persistence flow: an in-call artifact buffer the user can voice-confirm into wiki/research/etc. ("save these graphs to project X"). **Seed use cases:** (1) **Connector OAuth mid-call** — onboarding asks "want to connect Gmail? Let me pull that up" → agent opens the Gmail OAuth pane in a drawer → user taps once → returns to flow. Removes the post-call friction of "go to plugins, find it, install, come back." (2) **On-the-fly data viz** — discussing stocks / trends / data → agent renders a chart in-pane → user can voice-save it to a wiki page. **Strong overlap with Skills** (P0 in Plugin capabilities below) — Skills is the *invocation* layer ("what" the agent offers); ICS is the *render* layer ("where" it surfaces). Should be scoped together when the time comes. **Build-the-platform-first risk:** tempting to design generically before specific use cases demand it; that path produces architecture you spend months refactoring. Discipline: through slices 6.5–9, every time we hit a moment of "ugh, I wish this could happen in-call instead of after," collect it in this entry's notes. By the time we have 3-4 such moments, the right shape becomes obvious from the use cases themselves. **First use case already identified:** connector OAuth during onboarding. Source: post-slice-7 vision conversation. |

### Plugin capabilities (beyond MVP `research`)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Trial artifacts during onboarding (mid-call kickoff exception) | P0 | M | Feature + Infra | Originally scoped for MVP but bumped to V1 to keep MVP lean. During onboarding only, agent proactively offers + queues low-cost trial artifacts based on stated interests so they're waiting on the user's home screen post-call. Requires: onboarding-only mid-call tool (`queue_trial_artifact(kind, payload)`); server validates `call_type='onboarding'`; `agent_tasks.is_trial: bool` column for tier-cap exemption; onboarding scaffolding's tool palette declares the tool, generic does NOT. Hard cap 3 trial artifacts per onboarding call. Source: §8 Chunk 4 (originally), §10. |
| **Skills** — context-aware capability suggestions | **P0** | M | Feature + Infra | Pre-defined contextual prompt patterns the agent advertises based on the user's current context (reviewing an artifact, discussing a page, looking at a transcript, etc.). Each Skill is a registered template that composes existing primitives (wiki write via fan-out, plugin invocation, inline generation) — no new artifact infrastructure required for lightweight Skills; heavier ones graduate to plugins. Solves the "users don't know what to ask for" prompting-skill barrier; greatly increases perceived value per session. Sits in a parallel `skillRegistry` alongside `pluginRegistry`. Composes into call-agent prompt Layer 4 (capability advertisement) with trigger-relevance as a 5th availability filter alongside the existing four (System / Tier-granted / User-enabled / Connector-ready). Naming follows Anthropic's existing mental model. Seed set candidates: cheatsheet-from-research (wiki write), brainstorm-next-questions (inline), tangent-research (invokes research plugin), recap-to-email (V1+ Gmail), promote-to-todo (todo write). **Strongly complementary with Interactive Call Surface (Interaction modes section)** — Skills is the invocation layer ("what" the agent offers); ICS is the render layer ("where" it surfaces). Scope them together. Source: §8 Chunk 2 (capability advertisement) extension. |
| Podcast plugin | P1 | L | Feature | Script + audio-file-ref + player UI module. First binary-artifact plugin. Forces Supabase Storage pipeline. Source: §3, §11, §15c. |
| Email-drafting plugin | P1 | L | Feature | Requires Gmail connector. User-confirm-required write policy. Source: §11, §15, §15c. |
| Calendar-event plugin | P1 | M | Feature | Requires Google Calendar connector. User-confirm-required at MVP scope. Source: §11, §15, §15c. |
| Daily/weekly brief plugin | P1 | M | Feature | Aggregates recent activity + wiki state. Becomes a seed kind under the **Automations UI module** entry (Core surfaces) once that surface exists — i.e. "create a recurring brief automation" rather than a standalone tile. Source: §11, §15c. |
| Periodic usage + interest review | P2 | M | Feature | Scheduled background pass surfacing "you've been talking about X lately — want a weekly brief on it?" style recommendations. Own prompt + kind. Source: §13. |
| **Open-source plugin ecosystem** | **P3 (V2+ — long horizon, needs design)** | **XL** | **Feature + Infra (architectural direction)** | Maintain a tightly-managed set of "core plugins" (research, podcast, email, etc.) AND open the plugin library to developer contributions, à la Obsidian / VS Code / Raycast. **Pros:** crowdsourcing effect (free feature growth), social/network effect (community + retention + organic discovery), reduces solo-dev maintenance burden on long-tail capabilities, strong differentiator vs walled-garden assistants. **Cons:** (a) **trust boundary** — every third-party plugin is potentially adversarial code reading user wiki + transcripts; needs a sandbox runtime, capability scopes (request-scope read, request-scope write, agent-scope read?, etc.), audit trail, kill-switch per plugin. (b) **Developer UX** — third-party devs need a way to test their plugins against a fake user wiki / transcripts without accessing the core app codebase. Implies a published SDK + plugin-author CLI + local dev runner. (c) **Code review / store moderation** — manual approval for the marketplace; supply-chain risk; license + IP terms. (d) **Versioning + compat** — plugin API has to be stable enough to support installed plugins across app updates. **Architectural prerequisites:** stable plugin contract (signature for `(ctx) => Promise<{output, sources}>` already locked in `specs/research-task-prompt.md` — that's a start), capability scopes on `agent_tasks`, plugin manifest format (yaml/json with declared scopes + connectors + UI surfaces), runtime sandbox (likely WASM or strict V8 isolate). Worth ~2 weeks of focused design before any code. Cross-references: `Add-plugin tile / plugin marketplace surface` under Mobile-app polish (UX surface for installing) + `Custom `search_google` tool + provider abstraction` (provider-abstraction is a similar pattern that could template plugin abstraction). Source: post-slice-9 V2+ planning. |

### Custom agents

The full Agents-tile work (creation UX, persona customization, agent-level configs incl. the Model Intelligence Lite/Adaptive/Pro slider, agent picker on home, per-agent onboarding, deletion semantics, in-call config adjustment, Dreams surface) was promoted into `build-phases/v0.3.0.md` (Track C6) on 2026-05-12. Mid-session agent switching stays parked here as V1+.

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Mid-session agent switching | P3 | S | Feature | "Actually, talk to the Health Coach about this." Probably forced call-end + new call. Source: §15b. |

### Knowledge ingestion expansion

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
Note: "Upload sources pipeline" — the **document slice (PDF/markdown/text/maybe DOCX)** was promoted into `build-phases/v0.3.0.md` (Track B2) on 2026-05-12. The broader scope (URLs, images, audio, OCR/vision) remains here as a single XL parent entry below; the document slice that landed in v0.3.0 is intentionally not duplicated.

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Upload sources pipeline (non-document kinds — URLs, images, audio) | P1 | XL | Feature | Image OCR + vision, audio transcription, URL ingest (fetch + clean + extract). Mirrors transcript flow. Requires per-type extraction libraries. Document slice (PDF/markdown/text/DOCX) landed in v0.3.0; this entry is the remainder. Source: features.md, §3, §6. |
| Feeds as sources (content partnerships) | P2 | XL | Feature | RSS/equivalent ingestion on schedule. Partner revenue-share accounting. Source: §5. |
| Email ingest (received email as context) | P2 | L | Feature | Inbox as a source stream. Requires Gmail connector read scope. Source: §6, §15. |
| **Agentic ingestion pipeline rewrite** | **P2** | **XL** | **Infra + Feature** | Rewrite the Flash-retrieval → Pro-fan-out → commit pipeline as a single agentic operation. **Orchestrator** agent decomposes the transcript into work items and delegates to subagents. **Explore subagent(s)** retrieve related context — wiki pages, prior transcripts, uploaded storage, possibly web — feeding richer grounding into the write step. **Writer subagent(s)** take the retrieved context + transcript and produce the structured page/section writes. Open to additional roles (contradiction checker, editor/reviewer, promoter/demoter, etc.). Trades single-shot determinism for richer context-gathering + the ability to iterate on edge cases mid-ingestion. Tradeoffs: higher per-call cost (multiple inference hops), more complex observability (per-subagent token attribution), longer latency on the post-call window (acceptable since ingestion is async). Worth attempting after the current rewrite (2026-05-15) has been dogfooded enough to characterize its failure modes — those failure modes inform which subagents to start with. Source: 2026-05-15 prompt rewrite discussion. |
| **Structural-precedent substrate (per-page conventions + user-wide preferences)** | **P2** | **M** | **Feature + Data model** | Pro's "Page vs section/bullet" tier-2 rule (established precedent) currently reads only the visible wiki pattern from `touched_pages`. Two precedent sources need explicit substrate so the live agent can persist user-stated structural preferences: (a) **page-level convention notes** — a stable place on each wiki page to record patterns like "each book gets its own sub-page"; live agent writes when user states a rule, Pro reads on subsequent runs. Could be a dedicated `conventions` section, a structured field on `wiki_pages`, or `agent_abstract` content (cheapest). (b) **User-wide preferences** — `profile/preferences` or a separate persona-scoped prefs page captures cross-context rules. Both reduce restated-direction friction across calls; the visible-wiki-pattern signal alone covers the most common case but breaks down for preferences not yet observable in structure. Tie-in: live agent prompt needs guidance on WHEN to record vs WHEN to just acknowledge. Source: 2026-05-15 prompt rewrite Q&A. |

### Notifications + engagement

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Push notifications | P1 | M | Infra | Expo Push or native APNs/FCM. Per-platform cert management. MVP ships with in-app only. Source: §13. |
| Notifications feed data model | P1 | S | Data model | `notifications(id, user_id, kind, artifact_ref, body, read_at, snoozed_until, …)`. Source: §3, §13. |
| Notification grouping / snooze / dismiss | P1 | M | UX | Design pass on notification feed UI behavior. Source: §13. |
| Deferred confirmation (dropped-call flow) | P1 | M | Feature | Unconfirmed action items from a dropped call surface in notifications for deferred confirmation. Source: §8, §13. |
| Adaptive delivery channels | P2 | L | Feature | Global / per-task-type / per-schedule preferences: in-app, audio clip, email, push-summary. Source: features.md. |

### Scheduled + recurring content

The Automations primitive (recurring `agent_tasks` infra, Graphile recurring-job dispatcher, NL→schedule parser, per-plugin suggested defaults, pause/resume/edit) was promoted into `build-phases/v0.3.0.md` (Track B1) on 2026-05-12. Event-driven content stays parked here.

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Event-driven content | P3 | XL | Feature | RSS polling, topic-change detection, release alerts. Out of V1 entirely. Source: §12. |
| **Event-triggered automations** | **P2** | **L** | **Feature + Infra** | Beyond cron-based scheduling (which lands in v0.3.0 B1), let automations fire on EVENTS: "when a new item lands in Reading List, generate a podcast." Requires extending the recurring_agent_tasks schema with a `trigger_kind` discriminator (`schedule | event`) + per-event-kind payload (which entity, what change, optional filter predicate). Event sources at v0.3.0+: new wiki_page creates under a specified parent, new research output completions, new uploads, new transcript ingests. Each event source needs a publisher in the relevant write path (commit step / upload handler / etc.) that fires matching automation rows. Substrate dependency for "Custom user-script automations" (P2 elsewhere). Pairs with chained automations (below) — events are how outputs become inputs to the next link. Source: 2026-05-13 v0.3.0 B1 scoping discussion. |
| **Chained automations** | **P3** | **L** | **Feature + Infra** | Automations that fire on completion of other automations: "after Daily Brief lands, summarize the highlights into a tweet draft for me to review." Substrate: automation handlers emit a completion event (already implicit in agent_tasks.status='succeeded'); a chain-trigger automation listens for the originating automation's completion + fires its own kind. Composes with event-triggered substrate (above). Power-user feature; not for v0.3 or v0.4. Source: 2026-05-13 v0.3.0 B1 scoping discussion. |
| **Adaptive automation scheduling** | **P2** | **M** | **Feature + Prompt engineering** | Skip recurring runs when there's nothing new to act on (e.g., Daily Brief skips when there were no calls / no notes activity that day). Pause-on-idle-user (no app activity for N days → pause all recurring automations, resume on next open). Both are cost + UX wins — no point running expensive Pro fan-outs to summarize "nothing happened today." Substrate: handler-side noteworthiness check before doing the expensive work, OR a pre-flight gate in the dispatcher that consults recent-activity signals. Source: 2026-05-13 v0.3.0 B1 scoping discussion. |
| **Migrate dreaming-every-call to event-trigger substrate** | **P2** | **S** | **Tech debt + Infra** | The "every call" trigger for Dreaming ships in v0.3.0 #25 as a narrow custom hook inside `/calls/:id/end` (specifically: if user has dreaming-every-call enabled for the active agent, enqueue a dream agent_task at call-end time). This is a special-case hook, NOT a generic event-trigger system. When the broader event-triggered automations entry above lands (V1+), migrate this hook to use the generic `trigger_kind='event'` + `event_source='call_end'` pattern so we don't accumulate one-off hooks per kind. Source: 2026-05-13 v0.3.0 B1 scoping. |
| **Implicit reminder-pattern detection in Dreaming** | **P2** | **M** | **Feature + Prompt engineering** | Safety net for the v0.3.0 Reminders heuristics: when a user has created 3+ similar one-off reminders ("pay rent in March", "pay rent in April", "pay rent in May" — same intent, slightly different titles), the Dreaming REM phase's pattern detection surfaces a proposal: "you've set this kind of reminder N months running — want me to make it recurring?" On confirm, collapse the one-offs into a single recurring rule. On dismiss, suppress this specific pattern for N months. Pairs with v0.3.0 #25 Dreaming mechanics; sits as a follow-up because it requires both reminders + dreaming to be live first. Source: 2026-05-13 reminders nuance discussion. |
| **Reminder NL clarification UX** | **P3** | **S** | **UX + Feature** | Recovery affordance for cases where v0.3.0's "commit-don't-ask" heuristic produces a wrong default ("before end of month" → end-of-month due_date when user actually meant something else). Single-tap "correct this" affordance on the Todos row when reminder lands; opens a quick edit sheet with date/time/recurrence fields. Cheaper than mid-call clarification (preserves terse-command flow) but gives an explicit recovery path. V1+ — depends on the rolling-todo + edit affordances being solid first. Source: 2026-05-13 reminders nuance discussion. |

### User-assigned todo capabilities

The Reminders + Project-scoped todo lists work was promoted into `build-phases/v0.3.0.md` (Track B1.23 + C2.40) on 2026-05-12. Nothing remains here.

### Call mode expansion

Items promoted into `build-phases/v0.3.0.md` (Track A1) on 2026-05-12: Proactive call-end (#7), Live-agent abort tool (#4), Agent-driven call-end tool (#5). The "Live Agent ↔ UI capability parity" entry was **reshaped** — write-parity rejected outright (ingestion is single source of truth); the tour-guide variant lives in v0.3.0 as item #3. The "Live tools: `create_todo` + `create_note`" entry was **rejected outright**, not deferred.

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Contextual-call initialization from a wiki page / artifact | P1 | M | Feature | Start a call primed on the page the user is viewing. The viewed entity gets **priority preload** — same general-call preload as today, plus the focused entity injected with extra emphasis ("the user just opened this — they're likely calling about it"). Concrete trigger surfaces: wiki page detail, research output detail, todo detail, project detail. **Possible obsoletion:** if Interactive Call Surface lands first, this becomes redundant — the live agent would have UX-context-awareness via tools rather than a preload special-case. Track both paths; whichever lands first wins. Source: §8 + post-slice-7 review. |
| Call-type variants (task-specific calls) | P2 | L | Feature | Generic / contextual / "daily brief" / "brainstorm on X" call types with their own preload + prompt + call-end flow. Source: §8. |
| Mid-call tool set beyond `search_graph` (non-read tools) | P2 | M | Feature | Web search, URL fetch, calendar peek. Read tools for research + storage landed in v0.3.0; this entry is the remainder. Source: §8. |
| Call resumption after network drop | P2 | L | Feature | Resume or start fresh on reconnect. Source: §8. |
| Audio retention policy | P2 | M | Data model + Infra | MVP keeps transcript-only. Reconsider raw audio retention if (a) transcript quality issues warrant source-review, (b) users want to replay calls, (c) compliance/audit requires it. Adds Supabase Storage bucket per user, retention policy, playback UI. Source: §8 Chunk 5. |
| Reconsider "Audri's speech is not a claim source" invariant | P2 | S | Tech debt | MVP excludes agent turns from commitment extraction (per `specs/fan-out-prompt.md` §4.1) to prevent closed-loop hallucination. Reconsider when: Audri's clarifying restatements ("so you mean X?") followed by user confirmation are losing useful claim signal, OR a confirmation-aware extraction policy ("treat agent turn as claim source if explicitly user-confirmed in next turn") becomes worth the complexity. Source: §8 Chunk 5. |

---

## Infrastructure

### Plugin + registry

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Runtime-installable plugins | P3 | XL | Infra | Plugin registry becomes DB-backed; installable at runtime vs. via code deploy. Deferred until bundle size or install flexibility becomes a real constraint. Source: §11, §15c, tradeoffs. |
| Third-party plugins / marketplace | P3 | XL | Infra | User-authored or marketplace plugins. Source: §15c. |
| UI module registry | P3 | M | Infra | Separate `uiModuleRegistry` for projection-based UI surfaces. Currently YAGNI'd (Wiki + Todos handled as client-side built-ins). Revisit when 3rd projection module emerges. Source: tradeoffs. |

### Queue / background-loop refinements

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| **Revisit Graphile concurrency + multitenant scaling bottlenecks** | **P2** | **Varies (S–L)** | **Infra + Observability** | Track concrete bottlenecks identified in `.claude/architecture/bottlenecks.md`. Today's worker runs `concurrency: 4` in a single Render instance; per-user FIFO via `queue_name='ingestion-${user_id}'`. At private-release scale (10s of users) no action needed; entries in `bottlenecks.md` enumerate trigger conditions + remediation plans for each layer (worker concurrency, postgres pool, Gemini rate limits, section-merge tx-hold). Revisit each entry's trigger criteria when telemetry says it has fired. Source: 2026-05-13 architectural discussion. |
| Per-user fairness on `agent_tasks` | P2 | M | Infra | If one user's queue pressure starves others, add per-user `queue_name` pattern. Source: §11. |
| Per-kind concurrency caps | P2 | S | Infra | `queue_name='agent_tasks-${kind}'` if a specific kind needs throttling. Source: §11. |
| Handler checkpointing for long tasks | P2 | L | Infra | If LLM retry cost on crashes becomes material, add phased progress + partial-result caching. Source: §11, tradeoffs. |
| Reprocessing flows (transcript re-ingestion) | P2 | L | Infra | Prompt updates warrant re-running old transcripts. Requires dedup strategy (`(user_id, kind, stable_payload_fingerprint)` hash or `pipeline_version` tag). Source: §11. |
| Aggregate failure-rate alerts | P2 | M | Observability | Beyond Sentry per-error alerts, "failure rate > 5% in 5 min" style. Source: §11. |
| **Ingestion-job SLA timeout + high-priority telemetry** | **P1** | **S–M** | **Infra + Observability** | Today an ingestion job that hangs (Pro fan-out wedged, Gemini API timeout, worker process stalled, queue starvation under load) stays `status='pending'` indefinitely — no automatic surfacing, no retry, the Notes pending banner just stays lit forever. Add a mechanism to expire-or-fail any `call_transcripts` row whose `ingestion_status='pending'` (or `'running'`) for longer than the ingestion SLA. **Threshold:** start at ~5 min (typical ingestion completes well under a minute; 5 min is a generous outlier guard) but tune from observed p95/p99. **Mechanism options (resolve at spec time):** (a) **Graphile recurring sweep** — a cheap `expire_stale_ingestion` task scheduled every ~60s that flips overdue rows to `failed` with `ingestion_error='timeout'` and (optionally) re-enqueues with `max_attempts=1`. Simplest; runs independent of the original worker process so it survives worker crashes. (b) **Per-job timeout enforced inside the worker** — set a `job_max_duration` budget on the ingestion task itself; cleaner ownership but doesn't help if the worker itself dies mid-job (the row stays `'running'` orphaned). (c) **Hybrid** — handler-level timeout for the common case + recurring sweep as a backstop. **Telemetry:** every expiration emits a high-priority Sentry event (or PostHog metric, or both) tagged `ingestion-sla-breach` with `{user_id, transcript_id, queued_at, expired_at, status_at_expiry, retry_count}`. Distinct from the per-job failure path — SLA breaches indicate either (a) something hung weirdly OR (b) backend capacity pressure. Either is high-priority signal; should NOT be lost in normal-failure noise. **Pairs with:** existing `POST /calls/:id/retry-ingest` endpoint (already filters on `status='failed'` — SLA-expired rows route through the same retry path for free); **Aggregate failure-rate alerts** entry above (SLA breaches feed the same dashboard); the Notes pending banner (already renders the failed state with retry CTA — closing the loop visually for the user). Source: 2026-05-11 backlog. |
| **Application-level wall-clock timeout on Gemini fan-out calls** | **P1** | **S** | **Infra + Reliability** | Targeted defensive fix that lands faster than the broader SLA-sweep above. Today, both ingestion Pro fan-out (`apps/worker/src/ingestion/pro-fan-out.ts`) and upload/url Pro fan-outs (`apps/worker/src/uploads/fan-out.ts`, `apps/worker/src/url-sources/fan-out.ts`) call `getGeminiClient().models.generateContent(…)` with no application-level duration cap. Undici's `bodyTimeout: 15min` (set in `apps/worker/src/main.ts`) is **per-chunk** — a slow but steady Gemini token stream never trips it. Observed 2026-05-15: Plato's Republic upload ingestion ran >17 min before being manually aborted because the stream was alive but agonizingly slow. **Fix:** wrap each `generateContent` call in `Promise.race` against an `AbortSignal.timeout(N)` (or equivalent); on fire, abort the underlying request and throw a typed error (`PRO_FANOUT_TIMEOUT`). N starts at ~5 min — generous enough for legitimate long-context calls (a 400-page book under chunking is ~30s per chunk; aggregated < 5 min total wall-clock for the heaviest realistic single chunk), tight enough to kill genuine runaways. Plumb the typed error into the existing `isTransientFetchError` retry classifier so retry semantics stay consistent. **Pairs with:** chunked ingestion (v0.3 sprint #79) — chunking is the proactive shape change for known-large inputs; this timeout is the safety floor against any single chunk going runaway. Should land first (~30 lines) so chunking work doesn't have to also solve the timeout-class bug. Distinct from "Ingestion-job SLA timeout" entry above which is the broader graphile-sweep approach (option (b) in that entry is essentially this, broken out as its own focused work item). Source: 2026-05-15 Plato dogfood incident. |
| **Transactional email service** | **P0 (V1 prereq for waitlist)** | **S** | **Infra** | Outbound system email — distinct from the Gmail *connector* under "Connectors" (which is the user's own outbound). Use cases: waitlist invitation emails, password reset, account deletion confirmation, weekly-digest opt-ins (V1+). Provider: Resend or Postmark (both have ~$0–20/mo at our scale). Set up sending domain (DKIM/SPF/DMARC) for `talktoaudri.com` or whatever the prod domain ends up. Single helper `sendEmail({ to, subject, react|html })` that the admin interface + auth flows call. Source: post-slice-9 review (paired with waitlist + admin entries). |

### Connectors (all V1+)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| `connectors` table + OAuth flow | P1 | L | Infra | Per-user per-service rows, encrypted tokens, refresh flow, scopes, status. Token refresh as scheduled background task. Source: §15. |
| Capability registry (connector capabilities) | P1 | S | Infra | Module mapping `connector_kind → capabilities`. Plugins declare `requiredConnectors`. Source: §15. |
| Gmail integration | P1 | L | Feature + Infra | Google-first. Read vs. write scope decisions. Source: §15. |
| Calendar integration | P1 | L | Feature + Infra | Google-first. Source: §15. |
| Contacts integration | P1 | L | Feature + Infra | Google-first. Imported contacts map onto `person` pages + aliases. Source: §15. |
| Connector UX | P1 | M | UX | Settings screen; per-connector detail; disconnect action; granted-scopes display; connector-write receipts in activity stream. Source: §15. |

### Search expansion

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| `search_graph` implementation (FTS first) | P0 | M | Infra | Postgres full-text search over `wiki_sections.content` + metadata. Source: §18. |
| Embedding pipeline (pgvector) | P2 | XL | Infra | Semantic search. Model choice, compute-on-edit freshness, blended ranking with FTS. Source: §18. |
| Custom `search_google` tool + provider abstraction | P1 | M | Infra | MVP uses Gemini Live's built-in Google search grounding (config flag, no custom tool). Migrate to a custom `search_google` tool with a provider abstraction layer (Tavily likely candidate, alternatives: Brave, SerpAPI, Perplexity) when triggered by per-call cost visibility needs, provider switching needs, or fine-grained budget control. Behavior: server-side tool, snippet-only return, conservative per-turn budget. Source: §8 Chunk 4. |
| `maps-grounding` tool (Gemini Maps grounding) | P2 | S | Infra + Feature | Gemini exposes a built-in `googleMaps` grounding tool alongside `googleSearch` — provides location-aware answers (nearby places, directions context, place metadata) with the same per-request billing model. Unblocks Audri answering location questions accurately ("where's the nearest X to me", "what's the address of Y", "tell me about this neighborhood"). Wiring shape mirrors `googleSearch`: add `{ googleMaps: {} }` to `LIVE_TOOLS` in `calls.service.ts`; capture grounding metadata via the existing `groundingMetadata` callback (same `GroundingChunkMaps` shape per `@google/genai` SDK); new `event_kind='maps_search'` or shared `'web_search'` bucket on `usage_events` (decide at implementation). Prompt update: add to the "Tools you have" section in `composeGenericScaffolding` with the same expensive-use-sparingly framing. Mutually-exclusive-with-responseSchema caveat applies (same as `googleSearch`). Source: 2026-05-11 backlog after Gemini-pricing review. |
| `fetch_url` tool (read full URL content) | P2 | M | Feature + Infra | Beyond Google snippets — actually fetch + clean + extract URL contents for deeper grounding. Adds HTML extraction (Readability or similar), paywall handling, image/video skipping. Lets Audri summarize articles directly. Source: §8 Chunk 4. |

### Recent-activity cache

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Recent-activity materialized view or cache table | P2 | M | Infra + Data model | MVP computes recent activity (last N calls + wiki updates + completed artifacts + todos) via fresh query against `wiki_log` + `call_transcripts` + `agent_tasks` on each call start. When call-start latency becomes noticeable or the activity-stream UI (V1+) shares the same data, promote to a materialized view or dedicated cache table refreshed on event writes. Source: §8 Chunk 1. |

### Observability expansion

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| PostHog server-side events for metrics | P1 | S | Observability | Instrument task-lifecycle events. Dashboards follow. Source: Chunk 5 decisions, tradeoffs. |
| **PostHog feature-flag wiring (kill-switches)** | **P1** | **S** | **Observability + Infra** | Slice-9 ask: kill-switch flags for ingestion + research-task spawning so we can shut off either pipeline without redeploying. Needs: (1) PostHog account + project + API key; (2) `posthog-node` SDK in `@audri/server` + `@audri/worker`; (3) two flag checks at ingestion entry + agent-task dispatch entry; (4) optional `posthog-react-native` for client-side rollout flags later. Carried from slice 9; deferred at close-out 2026-04-28 pending account setup. Drop me the project key when you create it and I'll wire the SDK. |
| Dedicated log aggregator | P2 | M | Observability | Datadog / Logtail / Axiom / Grafana Loki. Replaces Render built-in when query needs or volume demand it. Source: §11, Chunk 5. |
| Distributed tracing (OpenTelemetry) | P3 | L | Observability | When correlation IDs in logs aren't enough. Source: §11, Chunk 5. |
| **Admin interface** (consolidated) | **P0 (V1 prereq)** | **L** | **Observability + Feature** | Internal-only web surface combining: (1) **Failed-task triage** — list of failed agent_tasks + ingestion runs, bulk retry, per-row error inspection (today: Sentry + ad-hoc SQL); (2) **Spend + usage dashboard** — reads `usage_daily_per_user` + `usage_daily_by_kind` views (already exist, migration `0011`), shows top spenders, daily trendlines, alert thresholds; (3) **Waitlist management** — list signups, promote-to-active, send invite emails, per-cohort throttle controls; (4) **User management** — find user, view their wiki overview, tombstone if needed, export their data (V1+). Auth: Supabase admin role gating + IP allowlist. Stack TBD — likely a small Next.js or NestJS+Vite app served separately from the public API. Replaces today's "log into Render + run psql" admin experience. Source: §11, Chunk 5 + post-slice-9 review. |

### Storage

The Supabase Storage bucket layout + document upload pipeline (PDF/markdown/text/DOCX) was promoted into `build-phases/v0.3.0.md` (Track B2.27) on 2026-05-12. Image/audio/URL/RSS source kinds remain in the broader "Upload sources pipeline (non-document kinds)" entry under Knowledge ingestion expansion.

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Per-user storage cap (tier-driven) | P1 | M | Infra | Hard cap on total bytes per user in `audri_storage` bucket, tied to subscription tier (free / paid tiers TBD). Pre-flight check in `POST /uploads` rejects with 413 / typed error before signed-URL issuance. Counter: `SUM(size_bytes) WHERE user_id=$1 AND tombstoned_at IS NULL`. UX path: distinct error code surfaces a "raise limit" affordance similar to the spend-cap banner pattern. Added 2026-05-14 alongside the upload pipeline substrate. |
| Concurrent upload cap (start at 1) | P1 | S | Infra | Limit concurrent in-flight uploads per user (initially 1). Server-side gate in `POST /uploads`: reject if user has any row in `awaiting_upload` state (or in `extraction_status in (pending, running)` if we want to also serialize extraction). Prevents 5x parallel 50MB uploads from blowing memory + Storage bandwidth. Bump higher as we observe behavior. Added 2026-05-14. |
| Mixed-media URL ingestion — YouTube transcripts | P1 | M | Feature | New `url_source_kind` enum value `youtube_video`. Detector: `youtube.com/watch?v=` / `youtu.be/`. Extractor: `youtube-transcript` npm package OR YouTube Data API ($ + key). Concatenate captions; metadata from oEmbed (title / channel name). Pro prompt gets a kind-specific section for video transcripts (timestamps optional). Variable transcript availability (auto-captions vs manual). |
| Mixed-media URL ingestion — Twitter/X threads | P2 | L | Feature | New kind `twitter_thread`. Detector: `x.com/<user>/status/` / `twitter.com/...`. Extractor: paid Twitter API OR Playwright scrape (fragile post-2023). Concatenate tweet thread; author + reply count metadata. Pro prompt: discussion-shape similar to reddit_thread. |
| Mixed-media URL ingestion — podcast episodes | P2 | XL | Feature | New kind `podcast_episode`. Detector: known platform hosts (Spotify episode pages, Apple Podcasts, audio content-types). Extractor: download audio + Whisper STT transcription (per-minute $$). Significant cost + latency; treat as deferred-async (status='running' for minutes). |
| Mixed-media URL ingestion — JS-rendered SPA fallback | P2 | M | Infra | When current Readability fetch returns near-empty body (extracted text < threshold), retry through Playwright headless render. Heavy dep (~100MB Chromium). Covers React-based blog SPAs where the initial HTML is a skeleton. |
| Mixed-media URL ingestion — redd.it short links | P3 | XS | Infra | Resolve `redd.it/<id>` short links → real Reddit URL before pattern matching. Today these fall through to generic Readability path and produce poor results. |
| Mixed-media URL ingestion — RSS feed items | P2 | M | Feature | New kind `rss_item`. Subscribe to a feed URL → server polls + creates one url_sources row per new item. Different lifecycle from one-shot ingestion (recurring). |
| PDF metadata extraction | P2 | S | Quality | pdf-parse's `info` field exposes the PDF info dict (Title / Author / CreationDate / Keywords). Surface these into url_sources/uploads metadata so PDF source pages don't fall back to filename for title. Currently we derive title from URL pathname for PDF URLs; the info-dict title is usually canonical. |

### Rate limiting + abuse

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Rate limiting | P1 | M | Security | Per-user call starts, task triggers, upload rates. Source: §20. |
| Abuse / quota ceilings | P1 | M | Security | Prevent runaway inference costs. Source: §20. |

### Environments

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Split dev / prod Supabase projects | P1 | S | Infra | MVP runs against a single Supabase project. Before opening up to non-Max users, split into dedicated dev + prod projects so schema iteration, seeded test data, and RLS experiments can't touch real user data. Includes: separate Supabase URLs/keys per env, Render env-var wiring, Drizzle migration runner pointed at the right project per env. Decided 2026-04-26 to defer. |
| **Render staging environment** | **P1** | **S** | **Infra** | Duplicate the existing `audri-server` + `audri-worker` services in Render with a `-staging` suffix. Point their `DATABASE_URL` at the staging Supabase project (depends on the dev/prod split above). All other env vars need to be filled in on the staging services (Gemini keys, Sentry DSNs, webhook secrets, etc.). Goal: migration runs + new-feature smoke tests don't hit prod. Listed in slice 9 build-plan; deferred at slice-9 close-out 2026-04-28. |
| **Mobile Sentry source-map upload via EAS** | **P1** | **S** | **Infra** | Set three EAS secrets so the `@sentry/react-native` Expo plugin can auto-upload source maps during prod builds: `SENTRY_AUTH_TOKEN` (org-level token with `project:releases` + `project:read` + `org:read` scopes), `SENTRY_ORG`, `SENTRY_PROJECT=audri-mobile`. Secrets set 2026-04-29; pending end-to-end validation on first prod crash. Until validated, production stack traces show minified line/col only — Sentry capture works, but frames are unreadable. Local dev builds resolve via Metro and don't need any of this. Slice-9 close-out 2026-04-28. |

---

## Data model

### First-class entity sidecars (architectural pattern)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| **Sidecar tables for first-class wiki entities** | **P0 (architectural direction)** | **L per entity** | **Data model + Infra** | **Pattern:** wiki page types that have a dedicated plugin surface UX get a 1:1 sidecar table joined on `page_id` to `wiki_pages`. Wiki page holds the universal stuff (title, agent_abstract, sections/body, parent hierarchy, links, tags). Sidecar holds typed domain columns for queries + indices. Ingestion writes both transactionally. Cross-references and search continue to flow through `wiki_pages`, so nothing is lost. **Governance rule:** only entities with their own plugin surface get sidecars — Wiki itself stays pure substrate; concepts/people/places/sources/notes stay pure wiki rows; sidecars are reserved for entities the user interacts with via a dedicated overlay (Todos, Projects, eventually Events). The "first-class" test = "does this have its own tile + overlay?" **Tradeoff:** schema duplication (two writes per entity, two reads per detail view); manageable at our scale, painful if discipline slips. Don't preempt — add a sidecar when the first feature genuinely needs a typed column. **Pattern proven 2026-05-10**: `todos` sidecar shipped during the v0.2.0 cycle (status enum + parent_page_id association + due_date + completed_at; backfill from existing wiki status-bucket structure; ingestion fan-out writes sidecar atomically with wiki page). Documented in `build-phases/v0.4.0.md` (UX continuation; renumbered multiple times — v0.3.0 → v0.2.1 → v0.2.2 → v0.4.0 — as backend work was prioritized ahead of UX polish). **Remaining sidecars TBD:** `projects` (when project plugin gains typed surface — status enum, started_at, target_completion_at, milestones), `events` (V1+), other plugin entities as their typed needs emerge. Source: post-slice-7 architectural conversation; first instance shipped 2026-05-10. |

### Artifact tables (V1)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| `podcasts` table + Storage bucket | P1 | M | Data model | `{ id, user_id, agent_tasks_id, script, audio_ref, duration_s, chapters jsonb, speakers jsonb, generated_at, tombstoned_at }`. Source: §3. |
| `email_drafts` table | P1 | S | Data model | `{ id, user_id, agent_tasks_id, recipient, subject, body, connector_id, status, sent_at, provider_message_id, generated_at, tombstoned_at }`. Source: §3. |
| `calendar_events` table | P1 | S | Data model | `{ id, user_id, agent_tasks_id, connector_id, title, start_at, end_at, description, attendees, status, provider_event_id, generated_at, tombstoned_at }`. Source: §3. |
| `briefs` table | P1 | S | Data model | `{ id, user_id, agent_tasks_id, kind, content, period_start, period_end, generated_at, tombstoned_at }`. Source: §3. |
| Per-artifact-kind junctions (when re-ingestion lands) | P2 | S | Data model | `wiki_section_research`, `wiki_section_briefs`, etc. Created per-kind when that kind opts into `reingestsIntoWiki: true`. Source: §3, §5. |

### Auxiliary tables

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Upload / ingested-source table | P1 | M | Data model | Raw file ref, mime type, provenance, processing status. Required for uploads pipeline. Source: §3, §6. |
| Proposed action-item table | P2 | M | Data model | User-confirmed vs. pending-confirmation rows from call-end flow, linked to originating transcript. Source: §3. |
| Recommendation table | P2 | M | Data model | Reuse notifications or dedicated table. Kinds: schedule-proposal, split-proposal, follow-up, merge-proposal. Source: §3. |
| Schedule / recurring-task table | P1 | M | Data model | Cron spec, task kind, params, delivery prefs, pause state, next-run, owner. Source: §3, §12. |

### Per-turn call ingestion (V2+)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| **`call_turns` table + per-turn ingestion** | **P2 (V2+)** | **L** | **Data model + Infra** | Today, ingestion is one batch pass after the call ends (full transcript → Flash retrieval → Pro fan-out → transactional commit). Per-turn would split it: each turn (or pair of turns) ingests immediately into a `call_turns` child table of `call_transcripts`, with much narrower context per pass. **Pros:** wiki updates feel live mid-call; pending state shrinks dramatically; cheaper Pro context per pass. **Cons:** loses batch coherence (Pro currently sees the whole call — can resolve cross-turn contradictions, identify multi-turn synthesis); write/retract risk if user reverses themselves later in call; cost direction net-unclear without modeling. **Hybrid options:** per-turn lightweight extraction + post-call full Pro pass; or adaptive batching every N turns / M seconds. **Why deferred from v0.2:** the Wiki pending indicator (v0.2 item #11) solves the "is anything happening?" UX problem cheaply, regardless of underlying ingestion shape. Per-turn is additive when revisited (new child table; doesn't rewrite existing ingestion). Cost/coherence modeling against a real transcript should precede any future commit. Source: v0.2.0 DP-8 deferral 2026-05-09. |

### Schema maintenance

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Full data model review pass | P0 | L | Data model + Tech debt | Audit types, relations, indexes, RLS policies, history retention once outstanding decisions resolve. Source: §3. |
| Indexes | P0 | M | Data model | Explicit plan for `wiki_pages(user_id, scope, type)`, slug lookups, `parent_page_id` descents, `wiki_sections(page_id, sort_order)`, FTS on `wiki_sections.content`, frontmatter jsonb GIN. Source: §3. |
| History retention policy | P2 | S | Data model | When do we switch from full snapshots to diffs or periodic snapshots. Source: §3. |
| Tombstone retention | P2 | S | Data model | Permanent or GC after N days. Source: §3. |
| Alias indexing | P1 | M | Data model | Trigram index on concatenated aliases vs. separate `aliases` table. Speeds voice disambiguation. Source: §3. |
| `wiki_log` retention / rollup | P2 | S | Data model | Policy for log growth. Source: §4. |
| **Wiki page-type taxonomy + seeder structure rethink** | **P1** | **M** | **Data model + KG maintenance** | The current page-type set (`note`, `concept`, `person`, `place`, `source`, `project`, `todo`, `todo_bucket`, …) and the seeder structure (`profile`, `todos`, eventually `projects` roots + their children) were chosen pre-MVP and have grown organically. Worth a clean-slate review before the next major surface lands: which types are actually first-class vs. emergent, which are pulling their weight in retrieval / fan-out / UX, what the canonical seeded shape should look like for a fresh user (post-onboarding), and whether the sidecar pattern (see "Sidecar tables for first-class wiki entities") changes how types are organized. Includes: review of `seedDefaultPages` content + structure, audit of which types ingestion actually emits vs. which are theoretical, alignment of type taxonomy with plugin surfaces, and a check that the type set composes cleanly with the upcoming Projects module + sidecar entities. Source: post-MVP backlog 2026-04-29. |

---

## UX / UI

### Core surfaces

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Wiki browse UI | P0 | L | UX | Virtual folders by `type`, hierarchy tree within each, search, filter by tag/type. Source: §19. |
| CRUD UI | P0 | L | UX | Create, tombstone, edit, merge (entity disambiguation), bulk ops, undo stack, "New Project" + "Move under…" affordances. Source: §19. |
| WYSIWYG editor choice + replacement of plain-markdown editor | P0 | M | UX | **Current state (post-MVP):** `WikiSectionEditor` is a bare RN `TextInput` with monospace fallback that holds raw markdown. Functional but unfriendly — users have to know markdown syntax, and the editor doesn't render bold/italic/lists/links inline as they type. **V1 target:** WYSIWYG section editor with the basic familiar affordances (bold, italic, lists, links, inline code, headings). Doesn't need to be feature-rich — just feel native + familiar. Candidates: Lexical (Meta's, RN-friendly), TipTap (ProseMirror-based, strong web-RN parity story), or a smaller RN-native editor library (`react-native-pell-rich-editor` is the lightest option, less polish). Storage layer stays markdown — only the input affordance changes. Source: §19 + post-slice-9 review. |
| Todos UI module | P0 | M | UX | Task-management UX over `wiki_pages WHERE type='todo'` + joined `agent_tasks`. Status tabs, check-off, due dates, sub-tasks, assign-to-agent. Source: §4, §15c. |
| Greeting subtext: live activity reflection | P3 | S | UX | Today the home greeting shows agent + plugin counts ("1 agent · 2 plugins"). Could show live activity ("1 research running · 5 todos pending") for a more dynamic surface. Pure polish. Source: post-slice-8 punt. |
| **Projects UI module + seed root page** | P1 | M | Feature + UX + Data model | Top-level "Projects" UI surface alongside Profile, Wiki, and Todos — dedicated space for stuff the user is working on. Projection over `wiki_pages WHERE type='project'` with hierarchy expansion (each project's sub-pages: tasks, notes, sources, etc. visible under it). Includes seed `projects` root page (V1 migration adds the row alongside existing `profile` + `todos` roots). New projects default to that parent; user can reparent freely. Lifecycle TBD — likely just `active` vs. `archived` (buckets, frontmatter flag, or simple tombstone-archive — design at spec time). Pairs with project pinning (P1 above) for preload prioritization. Same projection-module pattern as Wiki + Todos (no plugin registry, client-side query logic). Source: user request 2026-04-26. |
| **Custom user-script automations (NL-to-script interpreter)** | **P2** | **XL** | **Feature + Prompt engineering + Infra** | Beyond the seed automation kinds (daily brief / weekly recap / scheduled research), let users write *fully custom* automations in plain language and have a backend agent interpret + compile the request into an executable spec. Example: *"create a podcast every time a new item lands in my Reading List."* The compiler agent: (a) identifies the trigger ("new item in Reading List" → event subscription on `wiki_pages` create where parent = `<reading-list-page-id>`), (b) identifies the action ("create a podcast" → invoke `podcast` plugin with the new item as input), (c) emits a stored automation spec the dispatcher can run. **Substrate dependencies:** (i) event-trigger abstraction layered over the existing `agent_tasks` / cron pattern — schema needs a `trigger_kind` enum (`schedule | event` initially) + per-event payload. (ii) Plugin compatibility — the action's plugin needs to accept the trigger's payload shape, which the compiler agent validates. (iii) Sandboxing / safety — user-authored scripts shouldn't be able to run arbitrary plugins indefinitely; need rate-limit + cost-cap per automation. **Composes with:** Automations UI module (this is the "custom" mode), Hard spending-cap enforcement (per-automation budget caps fit naturally), Open-source plugin ecosystem (custom automations are a natural pre-cursor for community plugin patterns). Source: 2026-05-11 backlog. |
| Graph view | P2 | L | UX | Visualization library, default filters, interactions. Source: §19. |
| **App-level settings drawer (top-right avatar → cog)** | **P1** | **M** | **UX + Feature** | Replace the top-right home avatar with a settings cog. Tap opens a bottom-drawer with app-level configs. **Initial seed contents:** (a) **Color theme** — light/dark/system; honor `Appearance.getColorScheme()` as the default; persist via AsyncStorage + (later) `user_settings`. (b) **Notifications** — global toggle plus per-plugin sub-toggles ("notify me when research completes", "notify me when daily brief lands", etc.); per-plugin toggles register declaratively from `pluginRegistry` so new plugins auto-add notification slots. **Pairs with:** (i) **Agent-level configs** (Custom agents section) — those are scoped per-agent; this is the app-wide container they live inside. (ii) **Notification badges on home plugin tiles** (Mobile-app polish) — same notification settings drive both badges and push delivery. (iii) The "Coming soon: Preferences" stub on `Account` plugin home — the cog drawer probably absorbs that, OR Account keeps its own narrower scope (billing / usage / spending limits) while the cog handles app-wide UX preferences. Decide at design time. **Open at design time:** drawer position (bottom-sheet vs. full settings overlay), whether the cog also surfaces "Account" sub-link or stays separate. Source: 2026-05-11 backlog. |

### Activity + notifications surfaces

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Activity-stream UI | P1 | M | UX | Mixed-type feed with grouping + snooze. Source: §19. |
| Notifications UI | P1 | M | UX | In-app screen + push payload shape (once push lands). Source: §19. |
| Call-history UI | P1 | M | UX | Listing, filtering, linking back to spawned artifacts. Source: §19. |
| Pending-artifact placeholders in plugin overlays | P0 | M | UX + Infra | All artifact UIs (Research today; Podcast / Email-draft / Brief in V1+) should show in-flight artifacts as pending entries — not invisible-until-complete. User taps the Research tile mid-generation and sees "Researching: Italian restaurants in lower Manhattan… (~2 min)" with a spinner; row hydrates to the full output when ready. Big confidence win — proves the system is working without requiring users to wait blind. Generic pattern: any plugin overlay reads BOTH the artifact collection AND a "pending tasks" view (agent_tasks where status in ('pending','running') AND kind matches), unions them with kind-specific placeholder rendering. Requires syncing agent_tasks to mobile (currently server-only — would need RLS + realtime publication migration like research_outputs got). Source: post-slice-7 UX feedback. |

### Contextual affordances

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Phone FAB ubiquity | P0 | S | UX | Available from every screen. Source: §19. |
| Contextual-call initialization | P1 | M | UX | Pass current-page context into call start. Source: §19. |
| Contextual source creation | P1 | M | UX | Upload source directly from a wiki page; spawn research/podcast from a source; drill from transcript to touched pages. Source: §5. |
| Project pinning | P1 | S | UX + Data model | User explicitly pins `project` pages as "active"; feeds preload prioritization. Boolean column on `wiki_pages` (or dedicated pins table). MVP uses activity-derived hot-set; V1 layers explicit pinning over it for stable user control. Source: §8 Chunk 3, §19. |
| User-pinned wiki pages (general) | P1 | S | UX + Data model | Beyond projects, let users pin any wiki page they want preloaded reliably (a person they're tracking closely, a concept they're studying). Same boolean-column or pins-table mechanism as project pinning. Source: §8 Chunk 3. |
| Plugin launcher UI | P2 | S | UX | Prototyped but confirm MVP role. Source: §19. |

### Persona + agent UX

Persona editing + agent-level config levers + in-call agent-config adjustment were promoted into `build-phases/v0.3.0.md` (Track C6 Agents tile) on 2026-05-12. Nothing remains here.

### Mobile-app polish (spawned from `specs/mobile-app.md`)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Theme switcher + light-mode toggle | P1 | M | UX | All five Liquid Glass variants (Azure / Aurora / Ember / Verdigris / Void) tokened from MVP; V1 ships the picker UI + light-mode variants. Source: `specs/mobile-app.md` Themes. |
| Avatar tap → account / settings menu | P1 | S | UX | Top-right home avatar is a stub at MVP; V1 surfaces the account / settings menu. Source: `specs/mobile-app.md`. |
| Mic-mute UI on call screen | P2 | S | UX | Distinct visual state for muted mic mid-call. Source: `specs/mobile-app.md` Call screen. |
| **Speaker-phone toggle on call screen** | **P1** | **S** | **UX + Infra** | Calls default to the iPhone earpiece (small top speaker, like a regular phone call); a toggle on the call screen flips the audio session to the loudspeaker (handheld/hands-free use). Today the audio session is configured once in `useCall().start()` with `iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP']` — that locks "always speaker" rather than letting the user choose. Refactor: drop `defaultToSpeaker` from the initial session, expose a toggle button in the call-screen UI, route through `AudioManager.setAudioSessionOptions` (or `overrideOutputAudioPort`) on toggle. Persist preference per-user in AsyncStorage so the toggle's last-state sticks across calls. Pairs with the existing **Mic-mute UI** entry (similar in-call control). Source: post-MVP UX request 2026-05-05. |
| In-call transcript feed | P2 | M | UX | Live transcript visible mid-call, behind a setting. Most users won't want it (reading-while-talking is anti-pattern). Source: `specs/mobile-app.md` Call screen. |
| Per-screen status-bar hiding | P3 | S | UX | Full-immersion mode for call screen. Source: `specs/mobile-app.md`. |
| **Gesture priority: plugin-dismiss vs system home-indicator** | **P1** | **S** | **UX** | When a plugin overlay is open (Wiki, Research, Profile, Todos), the iOS home-indicator swipe-up should **dismiss the overlay first**, not background the entire app. Only when the home screen itself is foregrounded (no overlay open, not in a call) should the system swipe-up gesture work normally. Implementation: `UIScreenEdgesDeferringSystemGestures` (iOS) — RN exposes via `useScreenEdgesDeferringSystemGestures` from `react-native-screens` or via Expo config. Enable on screens where we want swipe-up to be ours; disable on the home screen. Pairs naturally with the plugin-as-app navigation refactor — the deferring-gesture flag lives on the overlay shell. Android-side: `onBackPressed` already handles the back gesture, but pull-down-to-close is iOS-only so this is mostly an iOS concern. Source: post-slice-9 UX review. |
| Add-plugin tile / plugin marketplace surface | P3 | XL | UX + Feature | Discoverable surface to enable + install plugins. Tied to runtime plugin installation (already P3). Source: `specs/mobile-app.md`. |
| **Gradient message bubbles** | **P3** | **S–M** | **UX** | Replace the current solid-pill `TranscriptBubble` rendering (used by both the live chat screen and Call History detail) with the gradient-mask pattern lifted from AnimateReactNative's facebook-messenger scaffold. Component already exists at `apps/mobile/components/animations/facebook-messenger-gradient-conversation/` with `mode: 'scroll-parallax' \| 'static'` props — just not wired into consumers. Parked 2026-05-16 after dogfooding showed the gradient effect didn't add value at short-conversation lengths (all bubbles fell into the same gradient region). Revisit when (a) conversations are routinely long enough that the parallax shift becomes meaningful, or (b) a different masking design (per-bubble gradient stops? color-cycling per turn?) ships separately and supersedes the scroll-parallax pattern. The MaskedView + scroll-following gradient implementation also taught us a debugging lesson worth keeping — the layout mismatch between a flow-positioned mask and an `absoluteFillObject` overlay produced ghost bubbles with no text; the fix was rendering both layers as flow children (documented in the component file). Source: 2026-05-16 UX iteration. |
| **True token-by-token chat streaming** | **P2** | **M** | **UX + Infra** | Today the chat screen delivers each agent turn as a single waterfall after several seconds of silence (covered by the agent-side typing indicator added 2026-05-17). Server already streams via `generateContentStream` and writes SSE-formatted chunks (`apps/server/src/chat/chat.controller.ts`); the bottleneck is the **client transport**: RN's `expo/fetch` runs through iOS URLSession, which buffers small chunked responses (~16KB threshold) until connection close, AND strips SSE framing from `text/event-stream` responses before JS sees them. Diagnostic confirmed 2026-05-17 — a 2-chunk server response landed as one ~28-byte decoded chunk on the client with the `data:`/`\n\n` framing already gone. **Fix path:** swap the client's plain `expo/fetch` body-reader for a proper EventSource implementation (`react-native-sse` is the leading candidate — it opens the connection in a way that disables URLSession's coalescing and parses SSE natively). Keep the server-side SSE chrome as-is. Confirm with a longer response (web-search-grounded answer = 2 model iterations, more chunks, easier to see streaming). Side benefits: cleaner reconnect handling, native heartbeat support. **Why not switch providers:** the streaming bottleneck is platform-level, not model-level — Anthropic/OpenAI streams hit the same URLSession buffering. **Why not server transport change:** padding the priming chunk to >16KB or going `Transfer-Encoding: chunked` text/plain are hackier and don't address the framing-strip side. Pairs with the **Gemini Live → Anthropic/OpenAI provider abstraction** entry only loosely — different layer, different problem. Source: 2026-05-17 chat dogfood. |
| **iOS RefreshControl tintColor not honored** | **P2** | **S–M** | **UX + Tech debt** | On iPhone simulator (and likely physical device) running RN 0.81 + Expo 54, `RefreshControl`'s tintColor renders as a near-black system default regardless of the value passed. The spinner does render at the correct position; only the color is dropped. Diagnostic isolation 2026-05-10: a control `<ActivityIndicator color="#ff0000" />` rendered in the SAME view tree (above the FlatList in the Wiki overlay) showed up red as expected — confirming the issue is RefreshControl-specific, not a parent-cascade or BlurView issue. **Tried and failed:** `tintColor` prop, `colors` array, `style={{ tintColor }}` cast, `title=" " + titleColor`, `progressViewOffset` 0/40, `key=` force-remount on `refreshing` toggle, imperative `setNativeProps({ tintColor })` post-mount. **Possible fix paths (deferred):** (a) Expo config plugin that sets `[UIRefreshControl appearance].tintColor` natively at app boot — small native code, sets a global default that all instances inherit; (b) revisit when Expo / RN bumps in case the upstream bug gets fixed; (c) replace with a custom Reanimated-driven pull-to-refresh (Max declined this — built-in should work). Spinner currently renders dark on dark BlurView surfaces; functionally pull-to-refresh DOES work, just visually subtle. Android side honors `colors` correctly. Backed by `apps/mobile/components/ResyncControl.tsx` header comment. Source: 2026-05-10 debugging session. |

### Sync + offline

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Conflict resolution policy | P0 | M | UX + Infra | User edits client-side while AI writes server-side. Last-write-wins vs. server-wins vs. merge. Source: §3. |
| Offline behavior | P2 | L | UX + Infra | What user can do disconnected; how edits queue + replay. Source: §3. |
| Initial hydration strategy | P0 | M | UX + Infra | Full dump on first login vs. paginated backfill + realtime. Source: §3. |
| **`call_transcripts` replication: status updates can be invisible to foregrounded clients** | **P1** | **S** | **Tech debt + Infra** | `apps/mobile/lib/rxdb/replication.ts` configures the `call_transcripts` replication with `pull: { lastModifiedField: 'created_at' }`. Because `created_at` doesn't move when `ingestion_status` changes, incremental pull cycles can't see status updates on existing rows — the client relies entirely on the Supabase realtime channel (or a cold-boot full resync, since MVP storage is in-memory) to learn that a transcript moved from `running` → `failed`/`partial`/`succeeded`. Diagnosed 2026-05-12 when a manual Supabase update to `ingestion_status` didn't surface in the foregrounded app until reload. Real-world impact: any realtime hiccup (backgrounded socket, transient WS drop, RLS-publication misconfiguration on a column) leaves the banner stuck. **Fix candidates:** (a) add an `updated_at` column to `call_transcripts` (DB trigger or explicit set on every UPDATE) and switch `lastModifiedField` to it — same pattern already used on `todos`, `agent_open_items`, `wiki_pages`, etc. (b) repurpose `ingestion_status_updated_at` if we want a status-specific monotonic field instead of a generic `updated_at`. (a) is preferred for symmetry. Pairs with the broader **Conflict resolution policy** + **Initial hydration strategy** entries above. Source: 2026-05-12 partial-status investigation. |

---

## Observability (V1+ beyond what's in MVP)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| PostHog server-side task-lifecycle events | P1 | S | Observability | See Infrastructure > Observability expansion. |
| Aggregate failure-rate alerts | P2 | M | Observability | See Infrastructure. |
| Admin triage dashboard | P1 | M | Observability | See Infrastructure. |
| Cost observability in-app | P1 | M | Observability + UX | Per-user cost breakdown by service ("where my tokens went"). Depends on pricing model (§17b). Source: Chunk 5. |
| Cost anomaly detection | P2 | M | Observability | Alert on user-level spikes. Source: Chunk 5. |
| Mobile audio + call telemetry | P1 | M | Observability | Reattach barge-in tuning telemetry (mic peak amp during playback, fired triggers + their amp values, echo baseline) once a dedicated mobile telemetry surface exists. Source: slice 3 cleanup 2026-04-27 — verbose console logs were stripped after barge-in was tuned via inspection. Also wire Sentry breadcrumbs for `/calls/{sessionId}/end` post failures (currently silent-swallowed). |
| Expanded PII redaction | P2 | S | Observability + Security | Grow the redaction field list as leaks are observed. Source: Chunk 5, tradeoffs. |
| Distributed tracing | P3 | L | Observability | See Infrastructure. |

---

## Security + Compliance

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Guardrails — defense-in-depth gating | P0 | XL | Security | All MVP design effort to date has been about what Audri *can* do. Companion track: defining what users **must not** be able to do. Multi-layer enforcement (model-side prompt restrictions + server-side validation + plugin-level allow/deny). No detail yet — track as a known gap to scope before public launch. Source: post-slice-6 retrospective. |
| RLS policy set | P0 | M | Security | Write the actual policies per table including write paths. Source: §3. |
| **RLS audit — fix unrestricted + policyless tables** | **P0** | **S** | **Security** | Sweep `pg_class` × `pg_policy` for tables with `rls_enabled=false` OR `rls_enabled=true AND policy_count=0`. As of 2026-05-15: (a) **`recurring_agent_tasks`** has RLS disabled — fully unrestricted; Supabase dashboard flags it. Needs RLS enable + per-user policies (`user_id = auth.uid()` for select/update/delete; insert via server only). (b) **`extracted_claims`** has RLS enabled but zero policies — effectively deny-all; only works today because the worker reads via `service_role` (which bypasses RLS). Add policies when the substrate is wired up to anything client-facing. (c) Audit script worth committing to `scripts/` so future tables don't drift into the same gap — pre-commit hook or CI check. Source: 2026-05-15 dogfood. |
| Agent-scope leak-prevention tests | P0 | M | Security | Test suite + audit trail for any endpoint that could return agent-scope content. Source: §3, §20. |
| Cross-agent leakage tests | P1 | S | Security | Verify per-agent partitioning; agent A can't read agent B's subtree. Source: `specs/agents-and-scope.md`, §20. |
| Auth methods decision | P0 | S | Security | Email+password, Apple, Google — confirm which. Source: §20. |
| Add Apple sign-in (deferred from slice 1) | P0 | S | Security | Apple sign-in deferred during slice 1 because Apple Developer Program enrollment is blocked on Apple support (as of 2026-04-26). Re-incorporate before TestFlight push (slice 9). `expo-apple-authentication` + Supabase Auth Apple provider; entitlement requires paid enrollment. Source: build-plan slice 1, judgement-calls. |
| Replace web-auth-session OAuth with native Google Sign-In SDK | P1 | M | UX + Security | Current OAuth uses iOS `ASWebAuthenticationSession` which forces an iOS system dialog ("Audri wants to use pkeroxdh...supabase.co to Sign In") — confusing first-impression because users see Supabase's domain. Native Google Sign-In SDK (`@react-native-google-signin/google-signin` or `expo-auth-session/providers/google`) skips that dialog by using Google's native sign-in bottom-sheet + idToken exchange via `supabase.auth.signInWithIdToken`. Requires iOS OAuth Client ID in GCP (separate from current web Client ID) and paid Apple Developer enrollment for the entitlement. Cheaper interim: Supabase Pro custom auth domain ($25/mo) makes the dialog say "Audri wants to use auth.talktoaudri.com" — same flow, friendlier copy. Source: slice 1 OAuth UX feedback 2026-04-27. |
| Account deletion flow | P1 | L | Security | Tombstone vs. hard-delete of all user data. Source: §20. |
| Data export | P2 | L | Feature + Security | "Download as git repo / zip of markdown" portability. Source: §20. |
| **Recurring backup to user-owned cloud storage** | **P2** | **L** | **Feature + Security + Infra** | Beyond one-shot **Data export** (above), let users connect a cloud storage destination they already own — Google Drive, iCloud Drive, Dropbox, OneDrive, generic S3 with BYO credentials — and have Audri push a recurring backup of their account data (notes, transcripts, agent-scope, artifacts) on a schedule. Distinct from Data export in two ways: (a) **automated/recurring**, not one-shot user-initiated; (b) **destination is user-owned external storage**, not a local download. **Why it matters:** durable escape hatch independent of Audri's infra (user keeps their knowledge even if we go down or they churn); meaningful trust signal that we're not holding their data hostage; pairs with the **On-device storage** entry as the "we don't lock you in" half of the privacy posture. **Open at design time:** (a) **format** — likely the same git-repo / zip-of-markdown shape as one-shot Data export, so the two share an exporter; (b) **schedule** — daily? weekly? user-configurable? on-demand button alongside the recurring one? Likely fits naturally as a kind under the **Automations UI module** (Core surfaces); (c) **provider matrix** — each destination needs its own OAuth (Google Drive + iCloud) or credentials (S3); prioritize Google Drive + iCloud Drive at V1+; Dropbox / OneDrive / S3 follow as user demand surfaces; (d) **encryption** — option to client-encrypt with a user-held key before upload, so the destination provider can't read the dump (matches the on-device-storage privacy posture; mandatory for the S3 BYO case where Audri shouldn't see the credentials); (e) **incremental vs. full** — full snapshot per run is simpler but expensive at scale; incremental requires diff state tracking. **Pairs with:** Data export (shared exporter); Automations UI module (natural home for the schedule surface); On-device storage (same trust axis); Connectors (shares the OAuth-to-third-party-provider plumbing). Source: 2026-05-11 backlog. |
| Secret management | P0 | S | Security | Server env vars + Supabase Vault for per-user tokens. Source: §20. |
| Token / secret storage for connectors | P1 | S | Security | Supabase Vault vs. server env vs. per-user encrypted. Lean Vault. Source: §15. |
| Graceful cleanup on account deletion during in-flight tasks | P2 | M | Security + Infra | Orphan-artifact cleanup. Source: §11. |
| On-device storage as a privacy position | P2 | XL | Security + Infra + Cost-Business | Evaluate making "your conversations and knowledge graph live only on your devices; our servers never persist them" a marketable claim. Scope is *storage*, not LLM inference (Gemini still sees content transiently under zero-retention terms). Requires flipping RxDB to canonical source-of-truth, moving ingestion Phase 1 + Phase 3 onto the device with the worker degrading to a stateless Gemini-call relay, serving `search_wiki` / `fetch_page` from RxDB, building user-key-derived encrypted backup for recovery, and either an E2E-encrypted CRDT relay for multi-device or a single-device V1 stance. Cheapest variant is a "local-only" opt-in tier (disables ingestion + agent tasks, keeps Audri as a local voice notebook) — partial answer that targets the privacy-maxi audience without the full rewrite. Open questions before promoting to a build phase: is privacy actually a wedge for our user, single-device vs. multi-device at V1+, regulatory tailwind, voice-layer asterisk severity. Full design exploration: `notes/on-device-privacy-options.md`. Source: 2026-05-09 design discussion. |

---

## Cost / Business

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Subscription tiers + pricing model | P0 | L | Cost-Business | Tiered subscription with gated usage vs. PAYG vs. hybrid. Source: §17b. |
| Usage events table | P0 | M | Data model + Cost | Full schema per §17b. Needed early even if pricing isn't decided — data accumulates for later analysis. |
| Rollup / summarization strategy | P1 | S | Cost-Business | Nightly `usage_daily` rollup for dashboard queries. Source: §17b. |
| Tier gating integration with `agent_tasks` | P1 | M | Cost-Business | `enqueueAgentTask()` wrapper checks tier caps. Deferred until pricing model lands. Source: §11, §17b. |
| Billing provider (Stripe) | P1 | L | Cost-Business | Not urgent until close to monetization. Source: §17b. |
| Quota enforcement points | P1 | M | Cost-Business | Call start, ingestion, plugin dispatch, upload endpoint, agent creation. Source: §17b. |
| Batch API usage for non-latency tasks | P2 | M | Cost-Business | Overnight briefs, bulk reprocessing. Source: §17. |
| Regeneration debouncing | P2 | S | Cost-Business | Summary + index regen triggered on write but coalesced. Source: §17. |
| Per-agent cost attribution | P2 | S | Cost-Business | `agent_id` on usage_events already carries this; surface V1+. Source: §15b. |
| Gemini explicit caching for ingestion scaffolding | P1 | M | Cost-Business + Infra | Cache the Flash candidate retrieval, Pro fan-out, agent-scope, and onboarding scaffolding prompts via Gemini's explicit caching API. Recurring Graphile job refreshes TTL. Per-prompt-version cache namespace. Estimated savings ~75% on input-token cost for ingestion (largest cost line). Worth doing once daily call volume crosses ~50/day OR monthly Gemini bill crosses ~$50. Deferred from slice 4 (2026-04-27) — at MVP volume the savings is cents per day vs. ~1-2 hours of infra to wire correctly. |
| **Waitlist + invite-driven user onboarding** | **P0 (V1 entry-gate)** | **L** | **Cost-Business + Feature** | **MVP gates users via TestFlight email allowlist** — no waitlist needed. **V1 introduces a waitlist** to control runaway cost while building toward cash-flow positive (or independent funding). Components: (a) public waitlist signup form (email-only, low friction); (b) `waitlist` table (`email`, `signed_up_at`, `invited_at`, `activated_at`, `referrer`, `notes`); (c) admin promote-from-waitlist flow → triggers invite email + supabase auth pre-registration; (d) per-cohort throttling so we don't onboard faster than budget allows. Pairs with the admin-interface entry below (where promotion happens) and the email-service entry (delivery infrastructure). Pricing-model decision (`Subscription tiers + pricing model` above) is upstream — waitlist gates against pricing tiers when those land. Source: post-slice-9 review. |

---

## KG Maintenance

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Linting / healthcheck background flow | P1 | L | KG maintenance | Cadence, triggers, checks (orphans, contradictions, stale claims, missing cross-refs, split candidates), autonomous-action scope vs. surfaced recommendations. Source: §7. |
| Auto-split long pages | P1 | M | KG maintenance | Scheduled lint scans for pages exceeding `MAX_LENGTH` (~2k words), proposes or executes nested split. Autonomous vs. confirmation-required (lean confirmation). Source: §7. |
| Auto-merge / entity-merge detection | P2 | L | KG maintenance | Detect near-duplicate pages / fragmented entity references; propose merging. Source: §7. |
| Cluster-to-project elevation | P2 | M | KG maintenance | Detect when related notes/concepts have grown into an implicit project; propose creating a `project` parent + reparenting the cluster. Source: §7. |
| Broken-wikilink repair | P2 | S | KG maintenance | Autonomous fix vs. recommendation. Source: §7. |
| Proactive-recommendation prompts (per kind) | P1 | M | KG maintenance | One per recommendation kind (scheduling, split, follow-up, merge). Source: §13. |
| Notes refactoring policy | P3 | M | KG maintenance | Should AI migrate content from freeform `note` pages onto canonical pages over time. Source: §4. |
| Bidirectional lookup performance | P2 | S | KG maintenance + Infra | Materialized view for reverse lookup (source → pages) at high-volume scale. Source: §5. |

---

## Tech debt + revisit flags

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Architecture.md sync | P0 | L | Tech debt | Make it the authoritative reference once production build begins. Currently substantially stale (see drift catalog). Source: §23 step 17. |
| Features.md sync | P0 | M | Tech debt | Lighter drift than architecture.md but missing custom agents, text mode, connectors/plugins as first-class. Source: §23 step 17. |
| Kind-registry = DB-backed | P3 | M | Tech debt | Revisit when runtime plugin installation becomes a real requirement. |
| UI module registry | P3 | M | Tech debt | Revisit when a 3rd projection module emerges (People view, Timeline view, saved-view mechanism). |
| `input_snapshot` on `agent_tasks` | P3 | S | Tech debt | Revisit if stale-context issues on mid-flight edits become user-visible. |
| Ghost recovery: don't count as attempt | P3 | S | Tech debt | Revisit if infra failures become common enough that conflating with handler failures is unfair. |
| Failed-task dedicated `todos/failed` bucket | P3 | S | Tech debt | Revisit if failure clutter hurts the pending-todo view. |
| Checkpointing for handler retries | P2 | L | Tech debt | Revisit if LLM retry cost on failures becomes material. |
| Restated-facts silent skip | P3 | S | Tech debt | Revisit if eval transcripts reveal Pro dropping actual signal framed as "already in wiki." |
| Flat index dump for Flash candidate retrieval | P2 | L | Tech debt | Refactor to retrieval-pre-filtered subset when wiki size breaks the full-dump. |
| Slug-only touched payload | P3 | S | Tech debt | Revisit if eval debugging needs per-flag rationale; add optional `reason` field for eval runs. |
| Artifact tombstone cascade for cited wiki sections | P3 | S | Tech debt | Wiki sections keep snippet + null the `ancestor_id`. Revisit if this causes UI weirdness. |
| Abstract regeneration on cosmetic-only edits | P2 | S | Tech debt | Decide whether pure reorders/metadata edits trigger abstract regen. Cost-driven. Source: §4. |
| Per-entity polymorphic artifact table | P3 | M | Tech debt | Reconsider if per-kind junction tables proliferate and share ~80% schema. Unlikely. Source: tradeoffs. |
| Canonical conditional context / prompt-forking system | P2 | L | Tech debt | Today's `composeSystemPrompt` branches by `call_type` ('generic' \| 'onboarding') with hand-written scaffolding per branch. As more conditional contexts arrive (research-task spawn, todo-spawn, mid-call agent switch, onboarding-resumption, plugin-context overlays), the branching will outgrow the if/else shape. Revisit when there are ~3+ conditional contexts in production and the pain becomes concrete — likely a registry-style prompt-layer composer. Source: post-slice-6 retrospective. |
| **rxdb-supabase: client-INSERT on push-enabled tables will fail (generated `_deleted` column)** | **P0 (blocks any client-originated INSERT)** | **M** | **Tech debt + Infra** | rxdb-supabase's `handleInsertion` sends the full local doc (including the synthetic `_deleted` field) as the INSERT payload. Postgres rejects writes to `GENERATED ALWAYS` columns with `428C9: column "_deleted" can only be updated to DEFAULT`. **The UPDATE side is patched** in `apps/mobile/lib/rxdb/replication.ts` via a custom `push.updateHandler` that strips `_deleted` from the SET clause. **The INSERT side is NOT patched** because rxdb-supabase v1.0.4 omits `handler` from its `push` options type — only `updateHandler` is user-customizable. MVP doesn't hit this because none of the push-enabled tables (`wiki_pages`, `wiki_sections`, `agent_open_items`, `todos`) take client-originated INSERTs: server endpoints + ingestion own creation, and `todos` rows are server-inserted alongside the wiki_page row. **Trigger conditions that will expose this:** (a) **Add-page affordance in wiki UI** (Core surfaces, P1) — if the manual "+ New page" flow inserts via RxDB rather than a server endpoint, the push will fail; (b) **manual section creation** in the WYSIWYG editor (Core surfaces, P0) if the new-section path goes through RxDB; (c) **client-originated agent_open_items writes** if any future plugin needs that; (d) **any new push-enabled table** added with a generated `_deleted`. **Fix options when this comes up, in order of preference:** (1) **Route the INSERT through a server endpoint** — mirrors today's wiki-create + todo-create paths; cleanest, no library work, keeps generated-column protection. (2) **Drop the generated-column constraint** on the affected table and replace with `boolean DEFAULT false` — clients can technically write `_deleted: true` but RLS confines blast radius to their own rows; for `wiki_pages` / `wiki_sections` where `_deleted = (tombstoned_at IS NOT NULL)` is load-bearing, add a `BEFORE INSERT OR UPDATE` trigger to keep them in sync. (3) **Fork or patch rxdb-supabase** to expose `push.handler` or accept an `insertHandler` option mirroring `updateHandler` — upstream-able. **How to apply:** when scoping a feature that would trigger a client INSERT on a push-enabled table, decide between options (1)–(3) at design time; don't ship the feature without the corresponding fix. Source: 2026-05-11 incident on `todos` UPDATE (Sentry-detected, UPDATE path patched same day); INSERT path deferred. |

---

## How to use this doc

- **Forward-looking only.** When an item ships, folds into a spec, or is promoted into a build-phase, cut its row and paste into `backlog-archive.md` under the matching section, prepending the closing date. Don't leave ✅/~~strikethrough~~ rows here — they pollute the planning surface and the agents that load this doc.
- When a decision lands "defer to V1+" in `todos.md` or `tradeoffs.md`, add an entry here with source reference.
- Before each new planning cycle (V1 kickoff, V2 kickoff), sort by priority to pick what lands in the cycle.
- Each entry should link back to the originating decision in `todos.md` / `tradeoffs.md` / a spec via "Source: …".
- Re-priority as understanding changes. An entry may move from P2 to P0 if a user behavior pattern makes it urgent, or from P1 to P3 if it turns out not to matter.
- Not a commitment — items may be dropped entirely when they turn out not to deliver. Move dropped items to `backlog-archive.md` under a "Rejected" section with a note on why.
- Cross-search across active + archive: `grep -r <term> .claude/architecture/`.
