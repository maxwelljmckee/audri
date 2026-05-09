# LLM Wiki Ecosystem — Survey & Actionable Insights

**Date:** 2026-05-08
**Status:** Research note — proposals pending user review
**Author:** Claude (read pass over six third-party write-ups + two repos)

## North-star UX

Pinned by the user, 2026-05-08, as the framing the recommendations below should be measured against. Phrasing is Paco Cantero's; the vision predates and is wholly Audri's. Tech stack and implementation are *not* the north star — this UX is.

> 1. I speak naturally, the system handles everything else.
> 2. Every thought, decision, and interaction is captured without friction.
> 3. The system sees patterns across every area of my life, not just one app.
> 4. Coaching and insights arrive without me asking for them.
> 5. It gets smarter every single day, not just bigger.

These are the felt-experience commitments our four core principles (Proactiveness, Transparency, Continuity, Autonomy/Control) are *trying to produce*. Use them as the test for any proposed feature: does it move us toward all five, or does it trade one for another?

Mapped against the actionable insights below: **#1 (scheduled hygiene)** and **#6 (concept-mastery)** target #5 of the north star (smarter, not just bigger); **#2 (vault-first research)** and **#3 (bi-temporal claims)** target #3 (cross-life patterns) and #5; **#4 (tiered maturity)** and **#5 (two-output rule, voiced)** target #4 (coaching arrives unasked) and Transparency. The proposals collectively over-index on #5 of the north star and under-index on #1 (speak naturally) and #2 (capture without friction) — those are largely solved by our existing voice-first call surface, which is why this survey doesn't generate new work there.

The survey alone leaves one north-star bullet under-served: **#4 (coaching/insights arrive without me asking)**. The user-articulated extension below — proactive gap-filling — is the connective tissue that targets it directly, and it ties the six discrete recommendations into a single autonomic loop. It's the headline integration of this note.

## Executive summary

A small ecosystem of "Karpathy-style LLM wiki" projects has emerged on top of Obsidian + Claude Code over the last ~3 months. Most articles describe the *idea* (already captured in `notes/karpathy-llm-wiki.md`); three implementations carry real design substance worth mining for Audri:

- **`eugeniughelbur/obsidian-second-brain`** — a Claude Code skill exposing 31 commands, a "vault-first research" pipeline, scheduled background agents (morning/nightly/weekly/health), an explicit "AI-first vault" rule, and a "two-output rule" that every interaction also mutates the wiki. Most concrete artifact in the survey.
- **`huytieu/COG-second-brain`** — PARA-numbered domains, multi-agent surface (Sonnet I/O + Opus reasoning), and a tiered people-CRM (Stub → Moderate → Full) gated by mention count.
- **Paco Cantero — *Mindset*** (DataDrivenInvestor, 2026-04-01) — a personal SQLite/React/Claude-Code system with 152 tables, 17 specialist persona-agents, 40+ skills-as-contracts with explicit verification, a universal `content_index` search row, and a "coaching intelligence layer" that tracks *concept mastery progression* (introduced → practiced → internalized → automatic) per agent. The strongest treatment in the survey of *agents that teach* rather than just retrieve.

Audri already implements the core Karpathy pattern (typed `wiki_pages` + h2-granular `wiki_sections` + per-source-kind junctions, persistent compounding artifact, LLM owns the writes). Six things from this survey are genuinely new for us and worth considering, ordered by ROI:

1. **Scheduled hygiene plugins** — nightly contradiction reconciliation, weekly synthesis, vault health audit. Maps cleanly onto our existing `agent_task_dispatch` worker + plugin registry.
2. **Vault-first / delta-style research** — bias the `research` plugin to start by scanning existing wiki, identify gaps, then search externally and produce a *delta report* against the user's current knowledge rather than a freestanding answer.
3. **Bi-temporal claims** — separate `valid_at` (when claim was true) from `recorded_at` (when we learned it). Lets us handle "I used to work at X" cleanly and is the missing axis on our `extracted_claims`.
4. **Tiered profile maturity** — explicit Stub/Moderate/Full state on `person`-typed pages, gated by source count. Sets reader expectations and makes call-side context selection cheaper.
5. **Two-output rule, voiced** — Audri verbally acknowledging what was committed to the wiki (post-call or mid-call), as a UX expression of Transparency from our core principles.
6. **Concept-mastery progression on agent-scope personas** *(new from Paco)* — give each persona a tracked teaching history with explicit mastery states. Turns the agent-scope from "private notes about the user" into a coaching trajectory the persona can reason about across calls.

Three patterns we should explicitly *not* adopt: filesystem-level wikilink self-healing (we have foreign keys), `.claude/skills/`-style agent surfaces (we have a typed plugin registry; competing surface fragments instead of helps), and a denormalized universal `content_index` table (Paco's pattern; our typed junctions plus Postgres FTS get us the same query reach with stronger invariants — see "patterns we should not adopt" below).

---

## Sources surveyed

Credibility column reflects how much concrete implementation detail the source actually exposes (vs. paywalled marketing).

| Source | Type | Substance |
|---|---|---|
| [`eugeniughelbur/obsidian-second-brain`](https://github.com/eugeniughelbur/obsidian-second-brain) | OSS Claude Code skill, MIT, ~966★, v0.6.0 (2026-04-26) | **High** — 31 documented commands, scheduled agents, AI-first rule, two-output rule, vault-first research. The most implementation-rich artifact in the survey. |
| [`huytieu/COG-second-brain`](https://github.com/huytieu/COG-second-brain) | OSS multi-agent framework | **High** — PARA layout, 17 skills + 6 worker agents (Sonnet I/O / Opus reasoning), tiered people CRM, multi-IDE agent surface. |
| [Paco Cantero — *I built an AI system that knows my entire life* (DataDrivenInvestor)](https://medium.datadriveninvestor.com/i-built-an-ai-system-that-knows-my-entire-life-here-is-how-it-works-4597c1fc44a6) | Medium, paywalled (full text obtained) | **High** — single-developer system "Mindset": SQLite (152 tables) + React/Express + Claude Code subprocesses with markdown memory synced via Git. 17 named persona-agents, 40+ skills-as-contracts with explicit post-run verification, universal `content_index` row-per-entity, 5-table coaching intelligence layer with concept-mastery progression. Local-only, ~€80/mo API spend. Built on the author's ICOR® methodology. Strongest treatment in the survey of *teaching* (vs. retrieving) personas. |
| [Evgeni Rusev — *How I built my second brain with Obsidian + Claude Code*](https://medium.com/@evgeni.n.rusev/how-i-built-my-second-brain-with-obsidian-claude-code-9fb54b7665ca) | Medium, free | **Medium** — clean schema-first thesis, frontmatter convention, selective-linking discipline; no command surface beyond conversational prompting. |
| [PARAZETTEL — *A couple of Claude-related tweaks*](https://parazettel.com/articles/a-couple-of-claude-related-tweaks/) (also republished on [Medium / Obsidian Observer](https://medium.com/obsidian-observer/two-claude-x-obsidian-tweaks-that-are-actually-useful-f74ce7652e3f)) | Blog post | **Low–medium** — two narrow tweaks: a CLAUDE.md directive ("CLI-first, fall back to file-system commands") and an Obsidian-native terminal plugin. Not directly applicable to Audri (no CLI surface, no Obsidian) but noted for completeness. |
| [Sonny Huynh — *I built an AI-powered second brain with Obsidian + Claude Code*](https://sonnyhuynhb.medium.com/i-built-an-ai-powered-second-brain-with-obsidian-claude-code-heres-how-b70e28100099) | Medium, **paywalled** | **Low** — content gated; preview only restated the three-layer Karpathy frame. |
| [Tech & AI Guild — *People are building a real Jarvis in Obsidian with Claude Code*](https://medium.com/tech-and-ai-guild/people-are-building-a-real-jarvis-in-obsidian-with-claude-code-heres-how-5a4ce86e461c) | Medium | **Low** — narrative/aspirational; no concrete configs. Worth one quote on the *interaction model* ("AI inhabits the user's environment and anticipates needs"), which is consonant with Audri's Proactiveness principle. |
| [`aimaker.substack.com` — *I took Karpathy's LLM Wiki and built…*](https://aimaker.substack.com/p/llm-wiki-obsidian-knowledge-base-andrej-karphaty) | Substack, partly paywalled | **Low** — exposes folder split (`sources/` immutable, `wiki/` LLM-managed, `inbox/` fleeting) and three command names: `/ingest-url`, `/process-inbox`, `/lint-wiki`. All conceptually present in our pipeline. |

---

## Patterns Audri already implements (validation, not action)

Worth naming so we don't redo work that's done:

- **Schema-first wiki with typed pages.** Our `wiki_pages.kind` enum (`person, concept, project, place, org, source, event, note, profile, todo, agent`) is the same move Rusev calls "the schema is everything." Our schema is tighter than any vault he showed.
- **H2-granularity write unit.** `wiki_sections` matches the `obsidian-second-brain` claim that fan-out should rewrite *parts of* pages, not whole pages.
- **Per-source-kind junctions.** `wiki_section_transcripts` / `_urls` / `_ancestors` is structurally what these projects approximate via frontmatter + wikilinks.
- **Sources immutable, wiki mutable.** Our `call_transcripts` / source rows are append-only; the wiki is the distilled layer. Same split as Karpathy's `sources/` vs. `wiki/`.
- **Index + log analogues.** `wiki_pages` + `agent_task_logs` (and the call-side `extracted_claims`) play the same role as `index.md` + `log.md`.
- **Plugin registry as universal trigger.** Equivalent in spirit to the `.claude/skills/` and `.claude/agents/` surfaces in COG and `obsidian-second-brain`, but typed and DB-backed instead of file-based.
- **Per-user FIFO ingestion.** Our `ingestion-${user_id}` Graphile queue is the multi-tenant version of these single-user wikis.
- **Inbox / fleeting capture.** The voice call itself *is* the inbox; Phase 1 retrieval + Phase 2 fan-out is the equivalent of `/process-inbox`.

---

## Actionable insights

Each below is a concrete proposal, mapped to existing Audri components. Ordered by ROI as in the executive summary.

### 1. Scheduled hygiene plugins on `agent_task_dispatch`

**Inspiration:** `obsidian-second-brain` ships four scheduled agents that run as background processes:

| Agent | When | Action |
|---|---|---|
| morning | 8 AM | Daily note + overdue tasks |
| nightly | 10 PM | Reconcile contradictions, synthesize patterns, heal orphans |
| weekly | Fri 6 PM | Weekly review |
| health | Sun 9 PM | Vault audit (contradictions, stale claims, orphan pages, missing cross-refs) |

**Audri mapping:** Each becomes a plugin-registry entry with the same five touchpoints any new plugin needs (registry entry, prompt, handler, artifact table, UI module, capability description). The dispatcher already runs against `agent_tasks` rows; scheduling is the missing piece. Two paths:

- **Cheapest:** `heartbeat` worker checks per-user "next-run" timestamps and enqueues. No new infra.
- **Cleaner:** Graphile's built-in cron support — already a transitive dep — registers crons per user-tier.

**What each plugin would actually do, scoped to our schema:**

- `wiki_health_audit`: SQL pass for orphan `wiki_pages` (no inbound junction rows), stale claims (`extracted_claims` older than N days never reconfirmed), `wiki_sections` missing source attribution, `person` pages stuck at Tier 3 (see #4) for >30 days. Output: a single `wiki_pages` page of kind `note` with a "needs review" section, optionally voiced into the next call's pre-amble.
- `nightly_reconcile`: re-run the fan-out prompt with a `mode: reconcile` flag over the day's new sections; output is a list of *pairs* of contradicting sections with a proposed merge.
- `weekly_synthesis`: consume the week's `extracted_claims` + new sections, produce a single synthesis section under a relevant `concept` page (or create one). This is `/obsidian-emerge` ("surface unnamed patterns from 30 days") shrunk to a week.

**Why this is high-ROI:** It directly addresses an inevitable failure mode — wikis decay without maintenance — that none of our existing plugins handle. And the *infrastructure* is already there; we'd be adding registry entries, not new subsystems.

### 2. Vault-first / delta-style research in the `research` plugin

**Inspiration:** `obsidian-second-brain`'s `/research-deep` is structurally different from a typical research agent. It runs:

> Phase 1: Vault scan (8+ relevant existing notes) → Phase 2: Gap analysis (5 targeted queries to fill silence/staleness) → Phase 3: Targeted external search → Phase 4: Delta report (what's new since baseline, what's confirmed, contradictions requiring updates with `[[wikilinks]]`, recommended updates, open questions).

**Audri mapping:** Our `research` plugin currently does open-ended research. The proposal is a prompt + flow change, not a schema change:

1. Plugin handler first runs a Phase-1-style retrieval over the user's existing wiki on the topic (we already have this exact tool — it's the call-side `search_wiki`).
2. Pass the retrieved sections into the research prompt as `## Existing knowledge (do not re-research)`.
3. Have the model emit gap-targeted search queries instead of generic ones.
4. Final artifact is a *delta report* with explicit references to existing `wiki_pages`/`wiki_sections` UUIDs that should be updated/contradicted.
5. Hand that delta report into the same fan-out → transactional commit path the call-side ingestion uses.

**Why this is high-ROI:** It's the difference between research-output-as-artifact and research-output-that-actually-grows-the-wiki. The latter is the entire premise of the LLM-wiki pattern; we currently only get it on the call side. Cost: one `research` prompt revision + a wrapper call to existing `search_wiki`.

### 3. Bi-temporal claims (`valid_at` + `recorded_at`)

**Inspiration:** `obsidian-second-brain`'s "AI-first vault rule" requires every claim to carry a recency marker (e.g. *"as of YYYY-MM, source.com"*) plus confidence. The author phrases it as a rule against "naked claims." More usefully, they distinguish *when something was true* from *when the wiki learned it*.

**Audri mapping:** `extracted_claims` already records `recorded_at` implicitly (row `created_at`) and source attribution. Missing: `valid_at` (or a `valid_range_start`/`valid_range_end` pair) so we can model:

- "I used to work at Anthropic" → claim *valid through 2024-Q3*, *recorded 2026-05*.
- "I work at Anthropic" → claim *valid from 2024-Q4 onwards*, *recorded 2024-Q4*.

The downstream consequence is that contradiction-detection in #1's `nightly_reconcile` becomes meaningfully cheaper: two claims about the same entity with disjoint validity intervals are *not* contradictions; they're history.

**Cost:** Schema migration adding `valid_at` (nullable, defaults to `recorded_at` for existing rows) plus a Phase 2 fan-out prompt update to extract validity when stated.

**Why this is medium-high ROI:** It's a small schema change that unlocks a much more accurate wiki for any user whose state changes (jobs, locations, relationships, beliefs). For a personal knowledge OS this is most users.

### 4. Tiered profile maturity on `person` pages

**Inspiration:** COG's people-CRM uses an explicit three-tier ladder gated by mention count:

- **Tier 3 (Stub):** 1 mention — name, role, context
- **Tier 2 (Moderate):** 3+ mentions — executive snapshot, style, strengths
- **Tier 1 (Full):** 8+ mentions or direct meeting — complete profile with sources

**Audri mapping:** `wiki_pages.kind = 'person'` could carry a `maturity` enum derived from a SQL count over inbound junction rows. Then:

- Call-side context-loading reads the *tier* and chooses how much to inject. A Tier-3 stub gets a one-liner; Tier-1 gets the full profile.
- Hygiene audit flags long-stale Tier-3 stubs ("you've mentioned Alex twice in 6 months — promote or prune?").
- The mobile UI could surface tier visually (small/medium/full card).

This is also generalizable beyond `person` — `project`, `concept`, and `org` pages have the same maturity gradient.

**Why this is medium ROI:** Modest schema work (a derived column or a view), but it gives both the agent and the UI a cheap signal for "how much do we actually know about this entity?" — which is currently implicit in row counts.

### 5. Two-output rule, voiced

**Inspiration:** `obsidian-second-brain`'s "Two-Output Rule" — every answer also updates relevant vault pages — paired with the project's "save reminders" that nudge the user after 10+ exchanges. The Tech & AI Guild article frames the same idea aspirationally as "JARVIS inhabits your environment."

**Audri mapping:** Post-call ingestion already gives us the *write*. What we don't currently do: *acknowledge it inside the conversation*, which is a UX expression of our Transparency principle from `project_ux_principles`.

Two ergonomic options, neither requires schema changes:

- **Mid-call lightweight ack:** During a long call, after each `commit_section`-equivalent tool call (we don't have one yet on the call side — we have `search_wiki`/`fetch_page`), Audri can verbally acknowledge: *"Noted — adding to your `Anthropic` page."* Note: this would require introducing a *write* tool on the call side, which is a non-trivial decision (currently writes are post-call only, by design — see `architecture.md`).
- **Post-call summary:** When the user returns to the app, briefly summarize what the ingestion pass committed: *"From last call I added 3 new sections and updated your `Anthropic` page."* This is purely a mobile-UI surface read against `wiki_sections.created_at`/`updated_at` and the call's session ID.

**Why this is medium ROI:** The post-call version is essentially free (a query + a card on the home screen). The mid-call version is more expensive and changes the ingestion contract — defer to backlog.

A small but cheap addition Paco's article suggests: a per-persona prompt clause along the lines of *"deliver one theoretical concept per session, woven into your response, and do not just analyze."* The agent-scope persona prompts (`persona_prompt`, `user_prompt_notes`) are the natural home; this is one paragraph of standing instructions per persona. Pairs with #6.

### 6. Concept-mastery progression on agent-scope personas

**Inspiration:** Paco's "coaching intelligence layer" is five tables that track what every persona-agent has taught the user, with each concept carrying a mastery state on the ladder:

> introduced → practiced → internalized → automatic

He claims 158 concepts tracked across 17 personas; each session has access to the prior teaching history and is *required* to build on it rather than restart. This turns persona memory from "facts about the user" into "a curriculum the persona is delivering."

**Audri mapping:** We already have agent-scope wiki pages — the persona's private notes about the user, kind=`agent`, partitioned per-persona via RLS. What we don't have: a structured *teaching trajectory*. Two cheap ways to add this:

- **Lightweight (v0):** add a `concept` page kind variant or a `concept_taught` row type that lives under the agent-scope namespace, with `concept_name`, `mastery` enum (`introduced | practiced | internalized | automatic`), `last_reinforced_at`, and an optional `cross_domain_links` array referencing other agent-scope concepts.
- **Heavier (v1):** a dedicated `agent_concept_progress` table, joined to the persona via `agent_id` + `user_id`, fed by a Phase-2-style extraction pass on call transcripts (the prompt looks for "X taught Y", "user said they understood Z", "user successfully applied W") and updated by the post-call ingestion.

**Why it's interesting for Audri specifically:** our roadmap already includes plugin-mediated personas with bespoke roles (research today; backlog has more). A concept-mastery layer makes those personas *coaches* rather than *retrievers* without changing the plugin contract. Combined with #1's `weekly_synthesis`, the same data powers a "what your French coach has taught you this month" surface.

**Why it's *not* in the top three:** it's a feature add rather than a fix to a known weakness, and it depends on having more than one persona delivering recurring teaching to be useful. Defer until V1 personas land — but worth the schema sketch now so we don't paint ourselves out of it.

---

## Headline extension: proactive gap-filling (user-articulated, 2026-05-08)

**The idea (Max's framing).** Audri should reflect on past conversations, scan the wiki for connections and gaps in its own knowledge of the user, and *autonomously surface questions* in future conversations to fill those gaps — about either follow-up threads or brand-new topics. This is the autonomic loop that makes the system *gather information it knows it needs*, not just file what the user happens to volunteer.

**Why this is the headline of the note, not just one more bullet.** The six insights from the survey are mostly defensive moves — preventing decay (#1), preventing redundant research (#2), preventing temporal confusion (#3), making known-state legible (#4), making writes legible (#5), and giving personas curricula (#6). All six target north-star bullet #5 ("smarter every day"). The proactive-gap-filling loop is the only pattern that directly serves bullet #4 ("coaching and insights arrive without me asking"), and it's the only one that closes the flywheel the others feed: once Audri can ask, the wiki reflects what the user *would have volunteered if asked*, not just what they thought to say. Without it, the KB ceiling is the user's recall and discipline — exactly the failure mode Paco names in his article and the one Audri exists to break.

**How it composes the other insights into a single loop:**

```
recent transcripts + wiki state
        │
        ▼
[gap_analysis plugin]  ← reuses #2's vault-scan; reuses #1's scheduling
        │
        ▼
agent_open_questions  (new table)
        │
        ▼
call-side prompt composer  ← reads queue, weaves K questions into persona prompt
        │
        ▼
voice conversation              ← user speaks naturally (north-star #1, #2)
        │
        ▼
post-call ingestion             ← matches transcript spans to pending questions,
        │                          marks them answered; same fan-out as today
        ▼
wiki updates + question lifecycle resolution
        │
        └─── feeds next gap_analysis run ───►
```

**What's already in place vs. genuinely new:**

| Component | Status | Cost |
|---|---|---|
| Recent-transcript + wiki retrieval | Exists (`search_wiki` tool, RLS-scoped) | 0 |
| Background plugin dispatch + scheduling | Exists (`agent_task_dispatch`, see #1) | 0 — same hygiene infra |
| Gap-detection prompt | New — but mechanically a sibling of #2's vault-first delta prompt | 1 prompt + 1 registry entry |
| `agent_open_questions` table | New | 1 migration; `id`, `user_id`, `agent_id`, `topic`, `question_text`, `priority`, `status` enum (`pending\|asked\|answered\|dismissed\|expired`), `created_by_task_id`, `created_at`, `asked_at`, `answered_at` |
| Call-side prompt composer reads the queue | New layer (or augmentation) in the 7-layer system prompt at `POST /calls/start` | Modest — but the prompt-engineering of *how* to deliver questions naturally is the hard part |
| Lifecycle: mark questions answered | New, but cheap if done **post-call**: extend the fan-out / agent-scope ingestion pass to attempt question-resolution against transcript spans | 1 prompt addition; zero new infra |
| Mid-call write to mark questions answered live | **Deferred trade** — currently writes are post-call only by design (`architecture.md`). Not required for v0; can be revisited if natural conversation demands it | 0 if deferred |

**Architectural questions Max's framing explicitly opens up:**

- *Does this require a runtime write tool?* No, not for v0. Post-call resolution is sufficient and preserves the current ingestion contract. The mid-call write becomes a real question only once we observe Audri *needing* to acknowledge resolution conversationally (the natural symptom would be a question being re-asked on the same call after the user already answered it).
- *Where does question generation live — per-persona or system-wide?* Per-persona is the right default: each persona has a private agent-scope view and its own curiosity. A `gap_analysis` plugin run is parameterized by persona. A user-scope global gap-finder can layer on top later.
- *Frequency / saturation gating.* Friction-by-reversal-cost (per UX principles) suggests a budget: *N* candidate questions per persona per week, *K* surfaced per call, with explicit dismiss/snooze mechanics. The user should always be able to see the queue (Transparency).
- *How do we keep questions feeling like genuine curiosity, not interrogation?* Prompt-engineering responsibility shifts to the call-side composer, not the gap-detector. The detector emits structured candidates (topic + reason it's missing); the persona prompt is responsible for translating one of those into "By the way, you mentioned your sister last week — does she live near you?" rather than "Question 3: where does your sister live?" This split is important.

**Why "we should not be afraid to adjust our technical approach" is the right disposition here.** The good news is that 80% of this fits the architecture we've already designed. The plugin registry is *already* the universal trigger for autonomous agent behavior. Scheduled hygiene (#1) is *already* the dispatch mechanism. Agent-scope (`scope='agent'`) is *already* the per-persona curiosity surface. The 7-layer call prompt is *already* a composable context-injection point. The only genuinely new primitive is `agent_open_questions` — one table — and the only deferred architectural choice is whether mid-call writes ever become a thing. This is not a rewrite; it's the natural next layer on top of what we've built. But the *prompt-engineering* effort is real and is where the design risk concentrates: a system that asks well-timed, naturally-curious questions feels magical; one that asks poorly-timed, interrogative ones feels broken. Budget for iteration here, not on schema.

**Where this lands relative to the other insights.** This is the highest-leverage proposal in the note. #1 (scheduled hygiene) and #2 (vault-first research) become *components* of this loop rather than standalone improvements. #6 (concept-mastery) becomes a domain-specific gap source ("user was introduced to X but hasn't practiced it — ask"). #5 (two-output rule, voiced) is the symmetric output channel. The right way to read this note now is: build #1 and #2 as the substrate, then build the gap-filling loop on top, with #3, #4, #5, #6 layering in as the loop matures. Concrete sequencing belongs in a build-phase doc, not here.

---

## Patterns we should *not* adopt

- **Filesystem wikilink self-healing.** COG advertises that renaming a markdown file auto-updates inbound links. We have foreign keys; this is solved at the layer below.
- **`.claude/skills/` or AGENTS.md as agent surface.** Audri is voice-first with a typed plugin registry. Adding a markdown-driven agent surface fragments responsibility for the same primitive.
- **CLAUDE.md "CLI-first" directive (PARAZETTEL tweak).** Audri has no Obsidian and no shell-level tool surface for the runtime agent.
- **Local-only / privacy-by-architecture (COG, JARVIS framing).** Audri is cloud-synced by design (RxDB ↔ Supabase, RLS for isolation). Local-only is a different product.
- **Frontmatter conventions (Rusev).** Our equivalent is normalized columns; YAML frontmatter would be a regression.
- **Universal `content_index` table (Paco).** Mindset writes one row per indexable entity — journal, person, interaction, article, chess move, etc. — into a single denormalized table so every search is one query. Tempting, but our typed junctions plus Postgres FTS (`tsvector` columns or a per-kind `gin` index) achieve the same query reach without the synchronization burden of a denormalized index. Worth a follow-up note to confirm `search_wiki` is actually fast enough across our growing junction set; if it isn't, the right fix is a materialized view, not a hand-maintained mirror.
- **Skill-as-contract files (Paco's 40+ markdown skills with explicit verification steps).** The *concept* — every workflow has trigger / steps / verification, and a step failure means the workflow reports failure rather than partial success — is good and we should adopt the *spirit* (post-handler validation in plugin handlers) without adopting the surface (markdown skill files separate from the registry). Filed as an open question rather than a decision.

---

## Open questions / next steps

0. **Proactive gap-filling (the headline extension above) is now the organizing target.** The right next step is probably a dedicated build-phase doc that sequences #1, #2, the new `agent_open_questions` schema, and the call-side prompt-composer change — not piecemeal adoption of the six recommendations. Open: do we open a `build-phases/<semver>.md` for this now, or sketch it in the backlog first?

1. Of the six proposals, which (if any) belongs in the next build phase vs. backlog? My instinct: #1 (scheduled hygiene) and #3 (bi-temporal claims) are the two highest-leverage; #2 (vault-first research) is essentially a prompt revision of an existing plugin and could land sooner; #4 (tiered maturity) is a small-schema unlock; #5 and #6 depend on richer call/persona feature sets and probably sit in V1 backlog with sketches reserved.
2. For #1: do we want one *generic* hygiene plugin that subsumes audit + reconcile + synthesis, or three separate plugins? The registry encourages narrow plugins, but these share a lot of context retrieval.
3. For #3: should `valid_at` live on `extracted_claims` only, on `wiki_sections`, or on both? Probably claims first (cheapest), with the section adopting the claim's validity range when promoted.
4. Worth a focused read of [`obsidian-second-brain`'s actual SKILL files](https://github.com/eugeniughelbur/obsidian-second-brain/tree/main) before designing #2 — the prompts in `commands/research-deep.md` are likely a useful starting point we can adapt.
5. **Plugin-handler post-run verification (from Paco).** Should every plugin handler emit a structured verification artifact (e.g. "schema-valid output", "all referenced wiki pages exist", "no orphaned sections produced") that the dispatcher logs alongside `agent_task_logs`? Lightweight, plugin-internal, and would make `wiki_health_audit` (#1) detect *its own* drift. Probably yes, but spec it on the back of the first hygiene plugin rather than as a standalone change.
6. **Density threshold as a UX observation (from Paco).** Paco reports patterns only emerge at ~3,000 entries. Our equivalent — when does a user's wiki cross from "useful" to "compounding"? — is a product-analytics question worth instrumenting as personas land, so we know whether to nudge new users toward more capture early or whether to time-pressure the cross-domain synthesis features.
