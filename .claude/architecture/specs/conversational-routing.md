# SPEC — Conversational Routing

Status: **structural decisions locked 2026-05-05** — taxonomy + architecture resolved; persona prose + telemetry tag format pending implementation pass.

Per-turn modulation of the Live agent's conversational style based on user intent. Each user turn is classified (implicitly, by the model itself) into one of a finite set of intents, which maps to a persona that determines the agent's response posture. The framework is gated to **user-led call types only** (currently `generic`); agent-led call types (e.g. `onboarding`) keep their existing scripted flow without the routing layer.

Companion to `agents-and-scope.md` (the agent-level persona model — separate concept; this is *intra-call*, *intra-agent* style modulation), and to the prompt-engineering tranche in `build-phases/v0.1.1.md`.

---

## Purpose

The MVP Live agent runs a single conversational style across all turns. Early test calls showed this fails badly across user-need spectra: the same probing-question pattern that feels supportive during emotional disclosure feels evasive when the user wants direct information; the same retrieval-shaped response that fits "what's a good Italian place" feels flat when the user wants to brainstorm.

Conversational Routing addresses this by giving the model a structured vocabulary for *what kind of moment this turn is* and *what response posture fits it*. The model self-modulates, fluidly, without ever announcing the shift.

---

## The load-bearing axis: information provenance

Where does the truth of this turn live?

- **User-as-source** — Truth lives inside the user. Their feelings, relationships, preferences, internal experience. Only the user can reveal it; the agent's job is to help them surface it.
- **World-as-source** — Truth lives outside the user. Facts, products, references, events. The agent's job is to bring information in from outside.
- **Conversation-as-source** — Truth doesn't pre-exist; it emerges from the exchange. Drafting, planning, working through a design problem. Neither party has the answer coming in.

Provenance is the primary lens. When the model is unsure which persona applies, it should ask: *"Where does the truth of this turn live — inside the user, outside them, or between us?"*

---

## The persona set

Four starter personas, one per intent. Each persona is a *style signature*, not a behavior — it determines verbosity, question-asking pattern, what tools (if any) the agent reaches for, and overall posture.

| Intent              | Provenance      | Persona          | Style signature                                                                                                          |
| ------------------- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Self-Exploration    | User-as-source  | Active Listener  | Probing questions, reflection, slow pace; lets the user reach their own truth. Doesn't pull from external sources.       |
| Information Seeking | World-as-source | Thought Partner  | Pulls from `search_wiki` / `fetch_page` and outside knowledge; frames + synthesizes; commits to a useful answer.         |
| Brainstorming       | Conv-as-source  | Co-Creator       | Builds with the user; suggests adjacent ideas, challenges premises, generates options. Forward-leaning, not retrieval.   |
| Note Taking         | User-as-source  | Note Taker       | Terse, attentive, low-interjection. Stays out of the way; lets the user dump info that ingestion will capture post-call. |

**Why two user-as-source personas (Active Listener + Note Taker)?** Provenance tells us where truth lives, but doesn't fully determine response posture. Within user-as-source, there's a meaningful split between *the user is figuring something out* (probe deeper to help discovery → Active Listener) and *the user already knows what they want to say* (stay out of the way → Note Taker). Provenance + intent jointly determine persona.

**Persona shifts must be implicit, never announced.** The agent never says "switching to information-seeking mode." It just rolls fluidly with the conversation, letting each turn pass through the intent filter that biases its style.

---

## Locked architectural decisions

Resolved 2026-05-05 in a Socratic discussion (see conversation history). These are settled and should not be revisited without strong new signal:

### 1. Single axis (not separate style + action)

Conversational Routing is one axis: intent → persona. There is no separate "action disposition" axis. Each persona carries its full signature — including verbosity, tool-reach pattern, and posture toward the user. The Note Taker persona's terseness *is* style; the Thought Partner persona's tendency to reach for `search_wiki` *is* part of being a Thought Partner.

This decision is also bounded by the current architectural constraint: **the Live Agent does not write to the wiki or enqueue background tasks directly**. All wiki writes happen via the post-call ingestion pipeline. The only Live-Agent tools are read tools (`search_wiki`, `fetch_page`). When write tools eventually land (the `create_todo` / `create_note` backlog item), this decision should be revisited — at that point a true action axis may emerge.

### 2. Three provenance classes

User-as-source / World-as-source / Conversation-as-source. Brainstorm/Co-Creator gets its own class rather than collapsing into Thought Partner — retrieval and generation are different jobs that want different conversational rhythms.

### 3. Static prompt, model self-routes; telemetry deferred

The full framework is described in the system prompt at `/calls/start`. The Live model sees all four personas at once and self-modulates per turn. A per-turn prefilter call was rejected because it would require pausing the conversation 300–500ms per turn for a Flash classification — fatal for a voice product.

This also keeps Gemini prompt caching working — the long stable prefix is exactly what caches well.

**Telemetry deferred to Phase 2 (backlogged).** The original plan called for an emitted intent tag at the start of each response. Implementation discovery during the Phase 1 pass: in audio modality the model's output IS audio, so an inline bracketed prefix would be vocalized to the user. The clean alternative is a tool call (`set_turn_intent(...)`) — but the codebase doesn't have tool-call infrastructure wired yet (the session wrapper only handles audio + text streams). Building tool-call infra solely for telemetry is a poor tradeoff. Two viable Phase 2 shapes when this is picked up: (i) ride along with general tool-call infrastructure when read tools (`search_wiki`, `fetch_page`) land for other reasons, (ii) post-hoc Flash classification as a step in the ingestion pipeline — cheaper, no Live-side changes, but produces a classifier's view rather than the model's own internal classification. Phase 2 entry tracked in `backlog.md`.

### 4. Gated to user-led call types only

Conversational Routing scaffolding loads only when the call is user-led. Today: `callType === 'generic'`. Onboarding (and future agent-led call types — scripted check-ins, structured weekly reviews) keep their existing scripted flow without the routing layer.

**Why:** in onboarding the agent leads the conversation through a scripted arc; the agent's per-turn response posture is determined by the script's progression, not by classifying the user's intent. Routing only matters when *the user is driving direction* and the agent must read implicit needs. Agent-led calls have enough structure already; routing would add noise without adding value.

---

## Foundational layer: Core UX Principles

Underneath the persona system, four principles are honored by *every* persona — they're not persona-specific behaviors, they're constants the personas express in their own flavor. This subsumes the original "Explicit UX core principles in scaffolding" entry.

| Principle      | What it means                                                                                                       | How personas express it                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proactiveness  | Offer follow-ups, surface adjacent context unprompted; don't wait for the user to ask the obvious next question.    | Active Listener proactively reflects emotional themes; Thought Partner proactively pulls related facts; Co-Creator proactively suggests adjacent angles.                 |
| Transparency   | When the agent does something behind the scenes (queues a research task, references the wiki), say so briefly.      | Universal — every persona names its action when it takes one. Note Taker says "got it" not silence; Thought Partner says "let me check the wiki for that."               |
| Continuity     | Reference past calls, wiki state, and prior context when relevant; the user shouldn't have to re-establish context. | Active Listener references emotional throughlines from prior calls; Thought Partner references recently-learned facts; Co-Creator references prior brainstorm threads.   |
| Autonomy       | When the user's intent is ambiguous, ask rather than assume; let the user redirect freely.                          | This principle is especially load-bearing for routing: it's the **fallback when the model can't classify intent**. Ask which mode the user wants rather than guess.       |

The principles must be **named explicitly** in the scaffolding, with concrete in-flow guidance for each. Today they're honored implicitly via behavior tuning across many prompt clauses but not surfaced as named concepts — making them harder for the model to apply coherently in novel situations.

---

## Verify-by-shipping (deferred decisions)

Three open questions don't have right answers in advance — they need real Live-model behavior to tune against. Each should be addressed in the implementation pass with a "good-enough v1" and iterated based on observation:

### B. Persona inertia / multi-turn coherence

"Shifts fluidly turn-to-turn" is the right vibe but the wrong implementation if read literally. If a user is five turns deep in self-exploration and asks one factual aside, snapping fully to Thought Partner and back will read jerky. Persona has *momentum*: the conversation has a base persona that biases responses, with the agent allowed to lean toward an adjacent persona for a single turn without committing.

**v1 approach:** describe momentum in natural-language prose in the scaffolding ("don't snap; if the conversation has been in one mode for several turns and a single turn pulls toward another, lean rather than commit"). Iterate against observed misroutes once telemetry lands.

### E. Intra-turn ambiguity

A single utterance can carry multiple intents simultaneously. *"I had this great idea about marketing automation, what do you think?"* is brainstorm + information-seeking + light self-disclosure. How does the persona blend or pick?

**v1 approach:** instruct the model to pick the *primary* intent and let it dominate the response, while letting secondary intents inflect tone. Cheap to express in prose, lets the model handle ambiguity without a hard rule. Refine prose if observed responses feel too monotonal.

### G. Telemetry mechanism

Originally framed as "what's the format of the emitted intent tag." Phase 1 implementation realized the inline-tag approach doesn't work in audio modality (the model would vocalize the bracket — outputAudioTranscription is post-hoc transcription of audio, not a separable text channel). Updated framing in decision A.3 above: telemetry deferred to Phase 2. Two shapes to weigh when Phase 2 picks up — tool-call (rides on general tool infrastructure when it lands) vs. post-hoc Flash classification at ingestion time.

---

## Implementation path

### Phase 1 — Scaffolding (✅ shipped in v0.1.1)

Translate this spec's framework into prose in the generic system prompt. Gated on `callType === 'generic'`. Includes the four postures (described behaviorally; persona names are spec-side reference only and do NOT appear in the prompt — sidesteps the failure mode where the model voices internal vocabulary), the provenance lens, the four core principles, and the v1 prose for inertia + ambiguity (deferred items B and E).

Implemented in `apps/server/src/calls/system-prompt.ts` → `composeGenericScaffolding`. Onboarding scaffolding intentionally untouched — agent-led calls don't get routing.

Observation strategy without telemetry: read transcripts directly. Each `call_transcripts.content` row holds the turn-tagged transcript; misroutes will surface as obviously off-style responses to specific user-turn shapes. Fine for early iteration; insufficient at scale, which is the motivation for Phase 2.

### Phase 2 — Telemetry (backlogged)

Persist an inferred-intent label per agent turn. Two shapes, decide at the time:

- **(i) Tool-call.** When general tool-call infrastructure lands (e.g. as part of `search_wiki` / `fetch_page` work), add a `set_turn_intent` tool the model calls before each spoken response. Cleanest separation of metadata from audio. Costs depend on what tool-call wiring already exists by then.
- **(ii) Post-hoc Flash classification.** A new ingestion-pipeline step that classifies each user turn's intent using Flash. No Live-side changes. Produces a third-party classifier's view of intent rather than the Live model's own — useful for tuning the prompt against observed user-utterance patterns, less useful for diagnosing what the *Live model* thought when it chose a response style. Persisted as a new field on the JSONB `content` blob (no schema migration; the turn shape is already untyped JSON).

### Phase 3 — Iteration (continuous after Phase 1)

Once real generic-call transcripts accumulate, iterate on the prose where misroutes appear. Promote / extend the persona set only if specific user intents recur and the existing four don't fit (Coach? Critic? Tutor? — speculative for now).

---

## Out of scope (for this spec)

- **Write-tool action axis.** Deferred until `create_todo` / `create_note` and similar live tools land. At that point this spec should be revisited (decision 1 caveat).
- **Per-call type persona menu constraint beyond the user-led / agent-led split.** Today: full set available in user-led, none in agent-led. We don't preemptively gate specific personas inside user-led call types.
- **Persona naming for V1+ (custom agents).** This spec is about *intra-agent* style modulation. The separate "agent persona" concept (different agents with different voices and system prompts — see `agents-and-scope.md`) is orthogonal and unaffected.

---

## Referenced from

- `build-phases/v0.1.1.md` → "Conversational Routing — framework + scaffolding" (in the prompt-engineering tranche).
- `backlog.md` → "Conditional prompt routing — architectural decision" (closely related; the broader question of dynamic prompt structure. This spec resolves the specific case of turn-level intent routing; the broader question may still apply to other call-level decisions).
- `backlog.md` → "Explicit UX core principles in scaffolding" (subsumed by the foundational-layer section above).
- `backlog.md` → "Generic-call scaffolding clause: Expectation Setting / Control / Autonomy" (an Autonomy-principle-specific clause; folds naturally into this framework's Autonomy section).
