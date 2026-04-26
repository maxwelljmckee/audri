# Constellate — Tradeoffs Log

Architectural decisions where we weighed real alternatives, recorded for traceability. Each entry names what we chose, what we passed on, the reasoning, and the trigger that would push us to revisit. Ordered by area.

This is a companion to `todos.md` (decision checklist) and `architecture.md` (current system design). Use this doc when a design choice starts feeling wrong — to see what else we considered and under what assumptions we picked this.

---

## Tech stack

### Gemini-only inference for MVP
- **Chose:** Gemini for everything (Flash + Pro + Live).
- **Passed on:** Anthropic for fan-out/research; multi-provider routing from day one.
- **Why:** ~2–3× cheaper tier-for-tier; explicit caching matches Anthropic prompt caching for our main use cases; already on Gemini Live for calls; single-vendor ops.
- **Gives up:** Anthropic's edge on hard reasoning; provider redundancy.
- **Revisit if:** A specific prompt refuses to stabilize on Gemini. The inference layer is abstracted (one internal interface) so a single pipeline can route to Anthropic without a full migration.

### EAS for mobile builds (vs. Fastlane on GitHub Actions)
- **Chose:** EAS Build + Submit + Update.
- **Passed on:** Fastlane on GitHub Actions (free to run).
- **Why:** Integrated Expo toolchain; OTA updates via EAS Update; free tier covers MVP; less YAML + signing-cert wrangling.
- **Gives up:** Per-build cost once the free tier is exceeded; vendor lock-in to EAS.
- **Revisit if:** EAS bills meaningfully exceed a comparable Fastlane-on-GHA setup.

### Graphile Worker for background jobs
- **Chose:** Graphile Worker — Postgres-backed, runs inside the NestJS process.
- **Passed on:** pg-boss (stagnant, last meaningful release ~2 years ago), BullMQ (requires Redis), Inngest (SaaS dependency + cost).
- **Why:** Actively maintained; single datastore with Supabase; TypeScript-native; cron + retries + priorities built in.
- **Gives up:** Inngest's durable-execution sophistication for complex sagas / long branching workflows.
- **Revisit if:** Throughput exceeds what a single Postgres can handle, or we hit real durable-execution needs (multi-step workflows with branching + compensation).

### Direct Gemini SDK (vs. Langchain)
- **Chose:** `@google/genai` directly. No Langchain.
- **Why:** Our pipelines (fan-out, preload, call-agent) are bespoke; Langchain abstractions fit them poorly and add indirection.
- **Gives up:** Prebuilt chains, retrievers, tools — we rebuild the ones we want.
- **Revisit if:** We find ourselves reimplementing large chunks of Langchain for multi-step tool use anyway.

### RxDB + Supabase replication (vs. raw SQLite + custom sync)
- **Chose:** RxDB wrapping SQLite (via `expo-sqlite`), using the Supabase replication plugin.
- **Why:** Observable queries (UI auto-updates when fan-out completes); turnkey bidirectional sync with built-in conflict resolution; subsumes the custom sync layer we'd otherwise build.
- **Gives up:** An extra abstraction on top of SQLite; some bundle-size cost; RxDB learning curve.
- **Revisit if:** RxDB blocks us on a performance or schema problem that raw SQLite would solve directly.

---

## Data model

### Sectioned pages — `wiki_pages` + `wiki_sections` (vs. monolithic `wiki_pages.content`)
- **Chose:** Page body lives in `wiki_sections` (h2-granularity rows with uuid, title, content, sort_order). `wiki_pages` holds metadata + `agent_abstract` + `abstract`. Pro reads the full joined page but writes at the section level.
- **Passed on:** Single `content` column on `wiki_pages` with full-page rewrites on every edit; line/paragraph-granularity diff-based edits (too fine).
- **Why:** Turns update cost from O(page size) to O(changed section size) — the load-bearing answer to the §17 cost-control problem. Unchanged sections cost ~36 chars (uuid only) in Pro's output. Contextual understanding preserved because Pro reads the fully-joined page. Timeline becomes "just a section with `title='Timeline'`" — Evergreen/Timeline dichotomy dissolves cleanly.
- **Gives up:** Higher schema complexity (two-table reads; history at section level; source junctions at section level; client sync covers two collections); section ordering management (sort_order); harder rollback ("page as of time T" = joined query across section histories).
- **Revisit if:** Section granularity proves wrong in practice — too coarse (we wanted paragraph-level diffs) or too fine (most edits span multiple sections anyway, negating the savings).

### Naming: `agent_abstract` + `abstract` (vs. `summary` + `overview`, `summary` + `lead`, `abstract` + `summary`)
- **Chose:** `agent_abstract` (required, terse, machine-consumed, ~1 sentence, surfaced in index + preloads) + `abstract` (nullable, human-readable opening paragraph).
- **Passed on:** `summary`/`overview` (easily confused); `summary`/`lead` (good but asymmetric); `abstract`/`summary` (inverts academic-paper convention).
- **Why:** `agent_` prefix makes the purpose explicit — "this is a first-class LLM prompt input." Scales if other fields acquire the same agent/user duality. Symmetric pair at different fidelity levels.
- **Gives up:** `abstract` as the *longer* field mildly inverts the academic connotation of "abstract" (terse). The `agent_` prefix anchors the distinction clearly; the inversion is documented here and otherwise ignored.
- **Revisit if:** Confusion emerges in practice; `summary`/`lead` is the clean fallback.

### Per-entity section-level source junctions (vs. page-level junctions or polymorphic `wiki_page_sources`)
- **Chose:** `wiki_section_transcripts`, `wiki_section_urls`, `wiki_section_ancestors`, `wiki_section_uploads` (V1). All keyed on `section_id`.
- **Passed on:** Page-level junctions (earlier decision, superseded by the sectioned page model); polymorphic `wiki_page_sources` (original proposal).
- **Why:** FK referential integrity; trivial JOINs; type-specific columns; precise citation granularity — snippet attaches to the specific section it grounded, not the whole page. Aligns with section-level writes.
- **Gives up:** One extra table per new source kind; reverse lookup (transcript → touched pages) is now two JOINs (`wiki_section_transcripts` → `wiki_sections` → `wiki_pages`).
- **Revisit if:** A long tail of source kinds all share the same columns — a polymorphic base with per-kind extension tables might be cleaner.

### Hierarchy + tags (vs. a `topics` page type)
- **Chose:** `parent_page_id` self-reference for nesting; `tags` for cross-cutting grouping. Dropped `topics` entirely.
- **Passed on:** A `topic` page type + `wiki_page_topics` join table.
- **Why:** One mechanism per axis, no overlap; smaller schema; less for the AI to reason about when routing claims.
- **Gives up:** A first-class "topic" noun in the UI/model.
- **Revisit if:** Users want a distinct concept of "topic" that neither hierarchy nor tags expresses naturally.

### Single `profile` type + hierarchy (vs. `profile_*` sub-types)
- **Chose:** One `profile` type. Sub-areas (Goals, Values, Health, Work, …) are child pages of a root `Profile` page.
- **Passed on:** Dedicated page types per sub-area (`profile_goals`, `profile_values`, etc.).
- **Why:** Fewer types for the AI to pattern-match on; aligns with hierarchy-as-nesting; sub-areas can be added or renamed without schema churn.
- **Gives up:** Type-level distinction between profile sub-areas (now expressed via parent only).
- **Revisit if:** We need per-sub-area schema (e.g., goal-specific frontmatter) that's awkward to keep in a shared type.

### Two-track slug strategy
- **Chose:** Walk-up for long-lived semantic types (`person`, `project`, `concept`, `profile`, `research`, `source`, `place`, `org`, `note`). `{kebab-title}-{short-hash}` for high-churn types (`todo`, likely `event` later).
- **Passed on:** Uniform walk-up for everything; uniform hash-suffix for everything.
- **Why:** Readable, stable slugs for semantic pages where humans will see URLs; collision-free slugs for pages that get systematically reparented (todos cycling through status buckets fragment walk-up slugs silently).
- **Gives up:** Two rules to hold in mind; ugly todo URLs (`buy-milk-a3f2`).
- **Revisit if:** Walk-up fragments silently in a long-lived type we didn't flag, or the hash-suffix ugliness becomes user-visible in a todo UI.

### Block tombstone on non-tombstoned children (vs. cascade)
- **Chose:** Block — user must reparent or tombstone children first.
- **Passed on:** Cascade tombstone of the whole subtree.
- **Why:** Explicit user intent; no silent mass-deletion from a careless action; safer given voice-first fuzzy targeting ("tombstone my project page" could ambiguously target multiple).
- **Gives up:** One more step when the user really does want to nuke a subtree.
- **Revisit if:** Users hit the friction repeatedly — could add an explicit "delete subtree" action separate from the tombstone flow.

### Todo status via reparent (vs. `status` field)
- **Chose:** Each todo is a page; status is expressed by which seeded bucket (`todo` / `in-progress` / `done` / `archived`) it lives under.
- **Passed on:** A `status` field in frontmatter; the four buckets become UI filters rather than pages.
- **Why:** One mechanism (hierarchy) for all structure; bucket pages make listings trivial; graph citizenship applies uniformly.
- **Gives up:** Reparenting on every status change introduces slug-collision risk (mitigated by the hash-suffix slug for `todo`).
- **Revisit if:** Systematic reparents cause perf issues, or hash-suffix ugliness becomes user-facing.

### Chronological pages = simple newest-first list (vs. current/superseded markers)
- **Chose:** Flat list, newest-first. No `current`/`superseded` markers, no separate "Current" / "History" sections.
- **Passed on:** Explicit current/archive split with maintenance invariants on write.
- **Why:** Attitude and view changes over time are preserved as meaningful context; cheaper prompt + UI; no invariants to maintain on write.
- **Gives up:** A one-line "what's currently true" readout — the LLM must synthesize it on demand.
- **Revisit if:** LLM consistently misreads older entries as current, or the UI needs a clearer "current state" summary.

### Organic Evergreen/Timeline split (vs. upfront ephemeral/evergreen tagging)
- **Chose:** Pages start as a single unqualified body; split into Evergreen + Timeline sections *only when a contradiction arrives*. Uniform across page types.
- **Passed on:** Tagging each claim as ephemeral or evergreen at ingest time.
- **Why:** No per-claim classification work; the split doubles as both page structure AND the conflict-resolution mechanism; simpler prompt.
- **Gives up:** Parsing prompt must handle *reclassification* (moving existing Evergreen content into Timeline when a contradiction arrives) — not just append.
- **Revisit if:** Reclassification proves too fragile in the prompt, or pages accumulate unsplit contradictions.

---

## Ingestion pipeline

### Entity resolution inline in Pro fan-out (vs. upstream Flash pass)
- **Chose:** Pro fan-out prompt resolves entities itself from the preloaded KG slice (which includes aliases). Flash does coarse candidate *retrieval* (which pages might be involved?), Pro does fine per-claim arbitration.
- **Passed on:** Separate Flash call producing a normalized mentions-to-slugs map consumed by Pro.
- **Why:** Simpler pipeline; lower latency; fewer moving parts for MVP.
- **Gives up:** Pro tokens spent on alias matching that could go to reasoning about claims; can't independently eval entity resolution accuracy.
- **Revisit if:** Routing accuracy is poor in practice or fan-out cost / latency balloons. A Flash pre-pass emitting resolved mentions is the clean next move.

### Preloaded slice = Flash's candidate set (vs. deterministic hot-set heuristic)
- **Chose:** Flash emits `touched_pages` + `new_pages` as part of its retrieval call; backend preloads full content of those pages for Pro.
- **Passed on:** Deterministic backend heuristic (string-match over aliases + recency + pinned projects) producing the hot set without an LLM.
- **Why:** Flash is already reading the transcript for the gate decision — marginal cost of also flagging candidate pages is small. Flash has judgment the heuristic doesn't: pronouns, implicit references, synonyms, contextual inference. One fewer piece to tune.
- **Gives up:** Flash's retrieval accuracy is now pipeline-critical; harder to independently reason about "is this noteworthy" vs "what does it touch"; Flash cost grows slightly.
- **Revisit if:** Flash recall becomes a measurable quality drag (claims routed to wrong pages because the right page wasn't preloaded) or if Flash cost starts dominating.

### No `fetch_page` fallback for MVP (Pro bounded by Flash candidates)
- **Chose:** Pro can only write to pages Flash preloaded. No tool to fetch additional pages; no two-pass structured retry; no second-pass "did we miss anything?" check.
- **Passed on:** `fetch_page` tool; two-pass structured ("pages_i_also_need"); post-hoc Flash miss-recovery pass.
- **Why:** Tool use + structured JSON output is awkward to make reliable in Gemini; two-pass doubles Pro calls; MVP prioritizes shipping over recall guarantees.
- **Gives up:** Recall. If Flash misses a touched page, the claim is silently dropped (or routed to an imperfect candidate).
- **Revisit if:** Evals show meaningful claim loss from Flash misses. Refactor paths in `notes/ingestion-pipeline.md` lay out the options (post-hoc recovery → two-pass structured → tool-use → embedding-union), in rising complexity.

### Flash pre-filter + Pro fan-out + mechanical SQL commit (vs. single call or multi-step LLM)
- **Chose:** Two LLM calls (Flash noteworthiness pre-filter, Pro fan-out main) then a deterministic SQL commit.
- **Passed on:** Single Pro call doing everything; multi-step LLM pipeline (noteworthiness → routing → per-page edit).
- **Why:** Flash is cheap and skips low-value transcripts before the expensive Pro call; structured JSON from Pro makes the commit pure SQL — idempotent, transactional, testable.
- **Gives up:** A second LLM call per processed transcript; Flash/Pro coordination.
- **Revisit if:** Flash is too conservative (drops noteworthy transcripts), too permissive (wasted Pro calls), or Pro alone proves accurate enough that Flash stops justifying its cost.

### Semantic-only LLM output contract (vs. full row-like JSON)
- **Chose:** LLM emits `title`, `slug`, `type`, `parent_slug`, `agent_abstract`, `abstract`, `sections` (with per-section `id` / `title` / `content` / `snippets`). Backend adds `user_id`, `page_id`, `section_id`, timestamps, `scope`, `tombstoned_at`, `sort_order`.
- **Passed on:** LLM emitting full row-like JSON including infrastructure fields.
- **Why:** Token budget stays on semantic content; LLM physically cannot fake a `user_id` or cross-write into another user's data; clean layer separation.
- **Gives up:** A small integration step marrying LLM output to infrastructure fields at commit time (already planned).
- **Revisit if:** N/A — this is a security invariant, not a cost tradeoff.

### Timeline stays flat — sub-grouping resolved by hierarchy, not section structure
- **Chose:** Timeline section is a flat newest-first bullet list. If Timeline appears to need sub-grouping (by attribute, by topic, by year), that is a signal the page's content belongs on separate pages — escalate by splitting via hierarchy, not by adding sub-structure within the section.
- **Passed on:** Grouped Timeline (e.g., `### Residence` / `### Career` sub-headers within the Timeline section).
- **Why:** Load-bearing, not just ergonomic. Sub-grouping collides with the sectioned data model (one `title` + one `content` per section row) and conflates temporal ordering (which lives inside Timeline) with structural hierarchy (which lives at the page level). Keeps Pro's output contract simple; uses a mechanism the system already has (pages + `parent_page_id`) to resolve growth.
- **Gives up:** Readability when Timeline gets long and covers multiple attributes. Hierarchy split is a manual-ish escalation (proactive recommendation via §7 lint, not automatic).
- **Revisit if:** Hierarchy-splitting doesn't trigger naturally and users end up with long, mixed-attribute Timelines that are hard to read.

### Implicit commitment extraction → multi-target write (vs. surface-only)
- **Chose:** When a surface claim matches a commitment pattern ("I told Alex I'd…", "I should…", "remind me to…"), Pro extracts both the surface fact (routed to the entity-relevant page) AND an implicit todo claim (routed to `todos/todo`).
- **Passed on:** Surface-only extraction; implicit todo only when user explicitly says "remind me."
- **Why:** Forgetting verbal commitments is a real user pain point. Voice-first calls naturally surface commitments without users translating them into "remind me" formulations. Pro has the context to distinguish commitment patterns from speculation/hypotheticals.
- **Gives up:** Recall risk inherited from the §4.3 MVP scope — if Flash doesn't flag `todos/todo` as a candidate for a transcript containing commitments, the implicit todo is silently dropped. Mitigation: Flash prompt should treat commitment-pattern presence as a signal to always flag `todos/todo`.
- **Revisit if:** Implicit todo capture proves too aggressive (users buried in todos they didn't intend) or too conservative (real commitments dropped). Either failure shifts the commitment-pattern list rather than the architecture.

### Muse's speech is not a source for claims (invariant, not tradeoff)
- **Chose:** Pro extracts claims only from the user's speech in the transcript. Muse's utterances are excluded from claim extraction, even when Muse restates facts back to the user.
- **Why:** Without this invariant, ingestion becomes a closed loop — Muse's inferences during a call could be written into the user's KG as if the user authored them. Hallucination amplification.
- **Gives up:** Nothing meaningful. Muse restating something is not new information.
- **Revisit if:** N/A — this is a security invariant, not a tradeoff.

### Skip-default for per-claim noteworthiness (vs. write-default)
- **Chose:** When in doubt about whether a claim is noteworthy, Pro skips it. Threshold framing in the prompt: "would a thoughtful reader six months from now gain anything from this claim?" If no clear yes — skip.
- **Passed on:** Write-default with aggressive Timeline use to soften over-writes.
- **Why:** The wiki suffers more from noise than from missed claims. A missed claim usually returns in another conversation; a noisy claim pollutes search and inflates inference cost permanently. Aligns with the §17 cost-control posture and the sectioned-pages design (sections optimize for *fewer, denser* writes).
- **Gives up:** Survivorship bias. Noise is visible (we see polluted pages); missed signal is invisible (we never see what we didn't write). The wiki may *feel* clean precisely because we silently lose information.
- **Revisit if:** Eval transcripts reveal Pro consistently dropping signal that users later expect to see in the wiki. Mitigation if it gets bad: a "second-pass" Flash review of the `skipped` array against the transcript to catch obvious misses.

### Restated facts → silent skip (vs. recency-bump or "still true" Timeline entry)
- **Chose:** When a claim restates a fact already captured in a candidate page, Pro skips silently. No Timeline entry, no field update, no recency marker.
- **Passed on:** (a) Adding `**Current** — (still true)` to Timeline; (b) bumping a `last_confirmed_at` column.
- **Why:** Timeline pollution from "still true" entries would balloon over time. A `last_confirmed_at` column adds schema and query complexity for an unclear UX win. The wiki already says the fact; nothing changes.
- **Gives up:** Recency signal — if a fact has been restated 12 times, we have no record of that frequency. Detection of "still-true vs. new-nuance-on-old-fact" depends entirely on Pro's judgment; misclassification loses the nuance.
- **Revisit if:** Recency surfaces as a real consumer signal (e.g., proactive recommendations need "facts the user keeps mentioning") — at that point, design a dedicated mechanism rather than retrofitting Timeline.

### Multi-target claim writes (vs. single-home + wikilinks)
- **Chose:** A single claim may write to multiple candidate pages — phrased from each target's perspective. "Sarah and I are starting Consensus" writes to both `sarah-chen` and `consensus`, with target-appropriate phrasing. Snippets on each write attach the same `turn_id`.
- **Passed on:** Single-home rule (claim lands on one canonical page; other involved pages get a wikilink reference).
- **Why:** Preserves searchability + context from any of the involved pages without requiring graph traversal. Aligns with the original "fan-out" framing of the pipeline. The user (or Pro in preload) reading `sarah-chen` sees the new project mentioned in-context, not as a link they have to follow.
- **Gives up:** Some duplication — the same underlying fact appears in slightly different phrasings on multiple pages. Source attribution prevents drift (both writes cite the same `turn_id`), but reading the wiki sequentially can feel repetitive.
- **Revisit if:** Duplication noise becomes a real readability problem, or if updates to one perspective cause stale phrasing on the other (deduplication is harder than just emitting both).

### Refinement & correction carveouts (vs. treating every attribute change as a contradiction)
- **Chose:** Pro distinguishes three patterns that look similar: **contradiction** (attribute actually changed over time → Timeline), **refinement** (new claim narrows/specifies an earlier broader one → in-place update), **correction** (user flags prior claim as wrong → wholesale overwrite, no Timeline).
- **Passed on:** Single rule treating any attribute-change-looking claim as a contradiction.
- **Why:** Without carveouts, refinements ("works at a startup" → "works at Consensus") and corrections ("I misspoke, it's Denver") would pollute Timeline with entries that either lose information (refinement → old broader claim appears as Past) or preserve history that shouldn't exist (correction → wrong claim preserved as Past). Explicit three-way distinction prevents both failure modes.
- **Gives up:** Added prompt complexity; Pro must reliably distinguish the three patterns. Correction detection in particular relies on user signaling ("I misspoke", "correction") and may fail silently otherwise.
- **Revisit if:** Timeline accumulates noise from refinements Pro misclassified as contradictions, or preserves wrong claims from corrections that weren't explicit enough.

### Top-level `creates` / `updates` / `skipped` arrays (vs. polymorphic `operations` array)
- **Chose:** Three top-level arrays in the JSON output, each with its own field shape.
- **Passed on:** A single `operations` array with `type: 'create' | 'update' | 'skip'` discriminator.
- **Why:** Resilient to LLM schema drift (a malformed `create` doesn't poison parsing of `updates`); matches backend write paths which differ per operation.
- **Gives up:** Slight redundancy when a page might appear in both arrays (shouldn't, but possible).
- **Revisit if:** N/A unless a concrete parsing issue appears in practice.

### Flash sees full wiki index dump for MVP (vs. retrieval-pre-filtered subset)
- **Chose:** Flash receives every user `wiki_pages` row in its system context as `{slug, title, type, parent_slug, agent_abstract}`. No section content. No retrieval pre-filter.
- **Passed on:** Embedding/trigram retrieval to pre-filter the index to a top-K subset; tiered approach with a `fetch_page_abstract(slug)` tool for on-demand details.
- **Why:** Zero retrieval infra. MVP wikis fit comfortably in the prompt. Pre-filtering would add an embedding store + query path before we know whether Flash recall is actually the bottleneck.
- **Gives up:** Scaling. Token cost grows linearly with wiki size; breaks at ~hundreds of pages per user. Latency drifts up before we feel cost pressure.
- **Revisit if:** Token cost on Flash starts dominating, or per-user wiki size approaches the size where we feel latency. Refactor path: trigram first (cheap, no embedding store), then embeddings if recall-by-string-match isn't enough.

### Flash output: slug-only touched + minimal new (vs. richer reasoning payload)
- **Chose:** `touched_pages` entries are `{slug}` only. `new_pages` entries are `{proposed_slug, proposed_title, type}`. No `reason`, no transcript snippet, no seed `agent_abstract`.
- **Passed on:** Including `reason` text or matched-snippet excerpts on each entry; seeding `agent_abstract` for new pages from Flash.
- **Why:** Pro re-reads the joined page + transcript anyway and re-derives the why; Flash's reason text would be discarded. Pro writes `agent_abstract` for new pages with full context — a Flash seed would be partial and competing. Saves Flash output tokens; keeps the contract minimal.
- **Gives up:** Observability — no audit trail of *why* Flash flagged each candidate; harder to debug Flash misses without inspecting transcript + index manually.
- **Revisit if:** Eval debugging requires per-flag rationale to diagnose Flash recall failures. Cheapest mitigation: add an optional `reason` field for eval runs only, gated by a flag in the cached prompt.

### Recall-biased Flash (vs. precision-biased)
- **Chose:** Flash explicitly biased toward over-flagging both `touched_pages` and `new_pages`. Prompt instruction: "when in doubt, include." Pro skips overflagged candidates cheaply via routing/noteworthiness; Pro cannot recover Flash misses.
- **Passed on:** Precision-biased Flash (only flag candidates above a confidence threshold) to minimize Pro preload cost.
- **Why:** Asymmetric error costs. False positives = small extra preload tokens, no quality loss. False negatives = silent permanent data loss with no recovery path (no `fetch_page`, no two-pass retry — see prior tradeoff entries).
- **Gives up:** Pro preload tokens on candidates that won't be written to. Pro per-call cost scales with the number of touched candidates.
- **Revisit if:** Pro preload cost from Flash overflagging starts dominating, *or* recall is good enough that we can tighten Flash's threshold without losing real claims. Either direction shifts the prompt's bias instruction; the architecture is unchanged.

---

## Agents & scope partitioning

### Design for multi-agent, operate at N=1 (vs. single-agent data model now, migrate later)
- **Chose:** `agents` table + `wiki_pages.agent_id` column shipped from day one, with a single seeded `Assistant` row per user at MVP.
- **Passed on:** Single-agent data model (no `agents` table, no `agent_id` column) with schema migration when custom agents land.
- **Why:** Near-zero extra cost upfront. Avoids a nasty migration later (populating `agent_id` across every agent-scope page + backfilling RLS filters while keeping the product running). Keeps the multi-agent mental model front-of-mind during all subsequent design work.
- **Gives up:** A little extra schema + one column on every agent-scope page that's always populated to the same value at MVP.
- **Revisit if:** N/A — this is a design posture, not a tradeoff likely to flip.

### Per-agent agent-scope partitioning (vs. shared agent scope across personas)
- **Chose:** Each agent owns its own agent-scope subtree; the Assistant's private notes are invisible to a future Health Coach and vice-versa. RLS filters by `(user_id, scope='agent', agent_id)`.
- **Passed on:** Shared agent scope — all personas see the same agent-scope wiki.
- **Why:** Each persona having independent observational memory matches the multi-persona mental model (different relationships with the user → different notes). Prevents cross-persona bleed (therapist context leaking into coach context, etc.). Easier to reason about what each agent knows.
- **Gives up:** Duplication of shared observations across agents (if the same insight is relevant to multiple, each must derive it independently). Cross-persona coordination (one agent building on another's notes) is disallowed at the data layer — feature by omission.
- **Revisit if:** Users report wanting agents to share memory (e.g., "the Coach and the Therapist should know the same things"). At that point the right answer may be an opt-in "shared agent-scope" partition, not collapsing the partition entirely.

### Separate agent-scope ingestion pass (vs. expand Pro fan-out to both scopes)
- **Chose:** A separate, lightweight Flash-driven pass handles writes to the active agent's private wiki. Pro's user-scope fan-out invariant (user-scope only) stays untouched.
- **Passed on:** Expanding Pro to write to both user-scope and active-agent-scope pages in a single call, with routing rules picking scope per claim.
- **Why:** Strict isolation reduces cross-scope leak surface (no "Pro routed a user-fact to agent-scope by mistake" failure mode). Agent-scope writes are observational and short-form — don't need Pro's contradiction/routing machinery. Keeps the fan-out prompt focused on the hardest user-scope work. Easier to eval, cost-track, and tune each pass independently.
- **Gives up:** Two passes = two Flash calls (agent-scope pass + Flash candidate retrieval for user-scope) + one Pro call per transcript, marginally higher cost than one combined Pro call. Two prompts to maintain instead of one.
- **Revisit if:** Cost of the separate pass proves material, *or* observations and user-facts turn out to share enough reasoning that combining them would genuinely benefit quality.

### Denormalized `agent_id` column on wiki_pages (vs. walk-up via `parent_page_id`)
- **Chose:** `agent_id` column on `wiki_pages`, nullable, required when `scope='agent'`, enforced by CHECK. Indexed with `(user_id, scope, agent_id)`.
- **Passed on:** Deriving agent ownership at query time by walking `parent_page_id` up to the agent's root.
- **Why:** Agent-scope reads happen on every call preload and every agent-scope ingestion pass. O(1) indexed filter beats recursive CTE. The column is cheap (single uuid, nullable); the walk-up CTE would be executed thousands of times per user.
- **Gives up:** Slight denormalization risk — `agent_id` must stay consistent with the subtree ancestor. Mitigated by CHECK + trigger on `parent_page_id` change (inherit agent_id from new parent).
- **Revisit if:** N/A.

---

## Data-flow architecture

### Todos as universal trigger for agent actions (vs. bespoke dispatch per capability)
- **Chose:** Every agent-executed action (research, podcast, email draft, calendar event, brief, future plugins) is mediated by an agent-assigned todo + queued job. Adding a capability = adding a todo kind + prompt + registry entry.
- **Passed on:** Per-capability dispatch paths coming out of ingestion (fan-out directly kicks off the research worker, directly kicks off podcast generation, etc.).
- **Why:** Uniform extensibility — new plugins slot in without touching ingestion, CRON, or dispatcher. Maps cleanly to the audit-trail principle (every artifact has a clear causal chain: transcript → claim → todo → job → artifact). Matches user mental model (assistant has a task list, executes tasks). Subsumes the §11 background-loop architecture.
- **Gives up:** One level of indirection — ingestion can't directly hand off to a worker; it writes a todo + task row and lets the queue find it. Adds an `agent_tasks` table (or equivalent queue substrate).
- **Revisit if:** Latency of the todo → queue → worker hop is too slow for a time-sensitive capability (real-time translation? live search during a call?). Those stay in-session via call-agent tools, not in the todo path.

### Todos = wiki page + `agent_tasks` row (vs. todos-as-wiki-only, or todos-as-table-only)
- **Chose:** Agent-assigned todos get both — a wiki page (user-facing: graph citizen, audit trail, cross-links, history) and an `agent_tasks` row (workflow substrate: typed payload, retries, status, concurrency locks, result FK). User-assigned todos ("buy milk") get only the wiki page.
- **Passed on:** (a) Todos-as-wiki-only — CRON scans `wiki_pages` with `type='todo'` and reads frontmatter for payload. (b) Todos-as-table-only — promote todos out of the wiki entirely into a dedicated table.
- **Why:** Two different concerns are being served. User-facing representation (graph citizenship, history, source junctions, cross-linking, edits, tombstones) fits the wiki model beautifully. Workflow substrate (typed payloads per kind, retry count, concurrency, scheduled_for, error tracking, result linkage) does not — frontmatter jsonb is the wrong shape, and scanning `wiki_sections` for queued work is the wrong query path. Splitting preserves both.
- **Gives up:** Two rows per agent-assigned todo; linkage discipline (keep `agent_tasks.status` and the wiki page's representation in sync). Slightly higher write cost at todo creation.
- **Revisit if:** The dual representation causes drift between the wiki page's todo state and `agent_tasks.status`. Mitigation: treat `agent_tasks` as canonical for workflow state, the wiki page for user-facing + historical state, with a single write path updating both atomically.

### Plugins as registry-driven extension mechanism (vs. hardcoded capabilities)
- **Chose:** Plugin = registry entry `{kind, prompt, handler, output_schema, capability_description, required_connectors}`. CRON dispatcher reads the registry; call-agent reads capability descriptions to know what to advertise; ingestion routes claims into known todo kinds. Adding a capability = registry entry + making the call-agent aware.
- **Passed on:** Hardcoding each capability directly into the dispatcher + call-agent prompt + ingestion rules.
- **Why:** Uniform extension surface; no per-capability changes across ingestion/dispatcher/UI. Keeps the system genuinely modular rather than modular-in-name-only.
- **Gives up:** A small amount of upfront design work to land the registry shape before the first plugin (research). Registry must evolve as capability needs emerge (e.g., capabilities that take multiple passes, capabilities that orchestrate sub-plugins).
- **Revisit if:** The registry's uniform shape can't capture a capability we need (some plugin requires bespoke scaffolding). Add a "bespoke handler" escape hatch rather than scrap the registry.

### Artifacts as per-plugin tables (vs. `wiki_pages` with artifact types)
- **Chose:** Each artifact kind gets a dedicated table (`research_outputs`, `podcasts`, `email_drafts`, `calendar_events`, `briefs`) + Supabase Storage buckets for binary artifacts. Text artifacts (research, briefs) re-ingest into the wiki as a follow-on ingestion pass with the artifact as source. Removes `research` from the user-scope wiki type set.
- **Passed on:** Artifacts-as-`wiki_pages` with `type` discriminator (`research`, `podcast`, etc.) — the original MVP decision.
- **Why:** Bespoke per-kind schemas that don't fit wiki's shape (podcast: audio_ref + chapters + duration; email: recipient + subject + body + connector_id + provider_message_id; calendar: start/end + attendees + provider_event_id). Binary storage is unavoidable regardless — podcast audio can't live in Postgres text columns. Cleaner mental model: wiki is "distilled knowledge," artifacts are "AI-produced outputs." Immutability becomes a table-level fact (no edit endpoints) rather than a per-row flag. Plugin UI modules (see below) map 1:1 to artifact tables.
- **Gives up:** Uniform schema / uniform query path. Each new artifact kind = new table + per-kind junction table (for re-ingestion) + migration + API endpoint. The "every artifact is a graph citizen" principle now requires per-kind source junctions instead of one uniform pattern.
- **Revisit if:** Per-kind tables proliferate and most kinds share ~80% of their schema — could collapse variants into a polymorphic `artifacts(kind, payload jsonb, ...)` table. Unlikely since each kind's distinguishing fields (audio_ref, recipient, start_at) are the exact fields we need structured access to.

### Re-ingestion as follow-on step (pattern defined, MVP opts all kinds OFF)
- **Chose:** Registry field `reingestsIntoWiki: boolean` per kind; when true (and not overridden by the handler's return), after artifact commit a follow-on ingestion job is enqueued with the artifact as source; findings fan out into wiki pages citing `wiki_section_<artifactKind>` junctions. **MVP: every kind defaults `false`.** Re-ingestion turns on V1+ once we have confidence in the pattern + source-junction granularity is right.
- **Passed on:** (a) Artifacts-are-wiki-pages (rejected above). (b) No re-ingestion ever — artifacts stand permanently alone. (c) Always-on re-ingestion for text artifacts at MVP.
- **Why:** Defining the pattern now costs nothing (registry field + handler return override) and avoids having to retrofit it later. Defaulting all kinds off at MVP avoids the complexity + cost of a doubled ingestion pass until we've seen how users interact with artifacts in their dedicated UI modules. If users never ask "where did my research go in the wiki?", we may never turn re-ingestion on at all.
- **Gives up:** MVP research outputs don't contribute to the compounding wiki — they're knowledge in the Research module but Muse can't reason over them in future conversations unless the user re-raises the topics. Explicit V1+ design debt to revisit.
- **Revisit if:** Users want research findings in their wiki (enable for `research` specifically; observe quality and cost). Or if Muse's performance in future conversations suffers visibly from not having research findings in its KG context.

### UI module registry (considered, YAGNI'd for MVP)
- **Chose:** No separate `uiModuleRegistry`. `pluginRegistry` covers queue-runnable capabilities only (Research, Podcasts, Gmail, Calendar, Briefs). Wiki and Todos are core built-in UI surfaces — always present, can't be uninstalled — with their data-fetching + filtering logic living client-side as ordinary queries against existing tables. No backend infrastructure for "UI modules that aren't plugins."
- **Passed on:** A parallel `uiModuleRegistry` splitting concerns between queue-facing (`pluginRegistry`) and navigation-facing (`uiModuleRegistry`). Would have cleanly modeled the two shapes of UI surfaces (artifact-backed vs. projection-over-existing-data) and made Wiki/Todos first-class "projection plugins."
- **Why:** Wiki and Todos are the only projection-shaped UI modules we foresee. Two-and-a-half special cases don't justify load-bearing infrastructure. Client-side hardcoded routes for these two surfaces is trivial; adding a registry mechanism just to avoid hardcoding them is over-engineering YAGNI. Backend design stays simpler — one registry, one concept of "plugin."
- **Gives up:** If we ever want a third or fourth projection-shaped module (e.g., a "People" view over `wiki_pages WHERE type='person'`, a "Timeline" view aggregating Timeline sections, a custom-filter saved-view mechanism), we'll need to either (a) keep hardcoding each one client-side, (b) build out the `uiModuleRegistry` then. Cost is concentrated at the moment we need the third one, not spread across the first three.
- **Revisit if:** A third projection-shaped UI surface emerges as a real requirement, *or* we want users to create custom saved-view surfaces (e.g., "my research on Topic X" as a dedicated module). At that point the registry becomes worth building. Until then, two hardcoded client-side routes is the right answer.

### Plugin-as-UI-module (vs. shared "Artifacts" surface)
- **Chose:** Each plugin ships a dedicated first-class UI module in the mobile app — Wiki, Research, Podcasts, Gmail, Calendar, etc. Each module queries its own artifact table and renders kind-specific affordances (research detail view, podcast player, email draft editor, calendar event confirm flow). Wiki is one such module, not a privileged main surface.
- **Passed on:** A single generic "Artifacts" UI listing all artifacts regardless of kind.
- **Why:** Kind-specific UX is fundamentally different (play an audio file vs. edit markdown vs. review+send email). Forcing them into a shared list would require the lowest-common-denominator UX. Matches mental model — Gmail and Calendar users already expect native-feeling app-like interaction, not a generic "artifact viewer."
- **Gives up:** More UI surface area to build + maintain; each plugin requires app-level UX design, not just backend changes. Adds module-switcher / launcher affordance to the navigation. Cost scales with plugin count.
- **Revisit if:** N/A — this is a UX product decision, not a reversible architectural one.

### Ingestion queue (vs. inline processing)
- **Chose:** Transcript commit enqueues an ingestion job on a dedicated Graphile `ingestion` queue with `job_key = user_id` for per-user serialization. Ingestion pipeline runs inside the worker; agent-tasks that result from commitments flow into the separate `agent_tasks` queue.
- **Passed on:** Inline processing (pipeline runs synchronously in the transcript-upload endpoint); ingestion as just another `agent_tasks` kind (would conflate operational queues).
- **Why:** Backpressure (many concurrent calls don't spike Pro inference). Per-user serialization for free via `job_key` (resolves the open concurrency question flagged in `notes/ingestion-pipeline.md` — two quick-succession calls can't race on the same pages). Uniform retry + observability with the rest of the queue infra. Independent concurrency tuning from agent_tasks (ingestion can be high-concurrency limited by rate limits; agent_tasks lower-concurrency since they're long-running).
- **Gives up:** One more queue to operate; ingestion has slight queue-dispatch latency (sub-second with pg NOTIFY, but non-zero); adds one layer of indirection for debugging a stuck transcript.
- **Revisit if:** N/A — near-zero cost to add, removes real concurrency risks.

### Capability-availability levels (vs. flat enabled/disabled)
- **Chose:** Four layered levels — (1) System (registry has the entry), (2) Tier-granted (subscription unlocks it), (3) User-enabled (user has explicitly turned it on), (4) Connector-ready (required connectors currently connected). Backend enforces all four with level-specific error messages; call-agent prompt composes capability descriptions from level 4; fan-out prompt from level 3.
- **Passed on:** (a) Flat enabled/disabled — single bit per user per plugin. (b) Two-level (enabled + available-given-connectors).
- **Why:** The reasons a capability is unavailable differ in what the user can do about them: "upgrade your tier" vs. "enable this plugin" vs. "connect your Google account" are different flows. A single "disabled" bit collapses them. Level 4 vs. level 3 distinction for prompts matters — Muse shouldn't advertise an email plugin if Gmail isn't connected (she'd offer something Muse can't do), but fan-out SHOULD route commitments into the enabled plugin and surface a connect-prompt afterward (more useful than silently dropping the commitment).
- **Gives up:** More enforcement points; more plumbing in the enablement UX; more ways to get the levels out of sync.
- **Revisit if:** N/A — this is the minimum structure that cleanly represents real user flows.

### Atomic enqueue + delayed-task CRON scanner (vs. CRON-only polling, vs. pg_notify triggers)
- **Chose:** Immediately-runnable tasks: application calls `graphile_worker.add_job()` in the same transaction that creates the `agent_tasks` row. Delayed + retry-eligible tasks: a Graphile recurring job polls every 30s, selects with `FOR UPDATE SKIP LOCKED`, enqueues up to 100 per tick.
- **Passed on:** (a) CRON-only polling — every task waits up to 30s before enqueue, adds floor latency. (b) pg_notify triggered wakeup on `agent_tasks` insert — lower latency than CRON, but more moving parts (trigger + notify handler + edge cases when notify is missed).
- **Why:** Atomic enqueue handles the hot path (common case = create row → run immediately) with zero latency overhead. CRON catches the delayed / retry tail. No orphaned rows possible (atomic). No missed-notify edge cases.
- **Gives up:** Two paths to maintain instead of one. 30s latency for scheduled/retry tasks (acceptable — these are explicitly not hot-path).
- **Revisit if:** N/A — hybrid is the standard pattern and avoids both single-path downsides.

### Graphile `queue_name` per user for ingestion (vs. `job_key`, vs. advisory locks)
- **Chose:** Ingestion jobs enqueue with `queue_name = 'ingestion-${user_id}'`. Graphile guarantees FIFO serialization within a queue name; different queue names run in parallel. Resolves the per-user ingestion-race concern with zero custom code.
- **Passed on:** (a) `job_key = user_id` — Graphile's default `job_key` behavior is deduplication (new job replaces the pending old), which is the wrong semantics. (b) Postgres advisory locks per `user_id` inside the handler — works but adds lock-management complexity; no free FIFO ordering. (c) Application-level queue/mutex — reinventing Graphile.
- **Why:** Native Graphile primitive, zero custom code, exact semantics we need (FIFO per user, parallel across users). Queue names are created on-demand; no pre-registration needed even at thousands of users.
- **Gives up:** Lots of queue names in Graphile's internal tables (one per user). Graphile handles this fine in practice.
- **Revisit if:** Per-user queue cardinality becomes a real operational pain (unlikely).

### `agent_tasks` as single shared queue (vs. per-user, vs. per-kind)
- **Chose:** `queue_name='agent_tasks'` for all background tasks, all users, all kinds. Concurrency controlled only by the worker pool size.
- **Passed on:** (a) Per-user `agent_tasks-${user_id}` — ordering within user doesn't matter for research/podcasts/etc. (Monday's research and Tuesday's research don't conflict on the same resources). (b) Per-kind `agent_tasks-${kind}` — no kind currently needs throttling; adding this pattern is cheap when first needed.
- **Why:** Simplest model that works; no unnecessary queue fragmentation; Graphile priority handles coarse ordering.
- **Gives up:** No natural per-user fairness (one user can dominate the queue with many tasks). Explicitly accepted — tier gating + priority will mitigate; refactor is cheap if needed.
- **Revisit if:** Per-user fairness starves users in practice, *or* a specific kind (e.g., podcast generation hitting a slow external API) needs concurrency cap — introduce `agent_tasks-${kind}` for that kind only.

### Transactional commit for idempotency (vs. handler checkpointing)
- **Chose:** Handler makes LLM calls outside any transaction, validates output, then opens a single DB transaction to write all artifact rows + source junctions + update `agent_tasks` status, commits atomically. On retry, LLM calls are re-executed (cost duplicated) but DB state is clean.
- **Passed on:** Checkpointing — handler writes progress to `agent_tasks` between phases; retries resume from last checkpoint. Avoids re-paying LLM cost on mid-run failures.
- **Why:** Much simpler; fewer bugs possible; retries are obviously correct. LLM cost duplication on retry is real but bounded (max_attempts from registry); at MVP scale cheaper than the complexity of checkpointing.
- **Gives up:** Wasted LLM cost on retries after partial progress. A handler that does a 30k-token Pro call, then crashes on the DB commit, re-runs the full 30k-token call on retry.
- **Revisit if:** Retries on expensive handlers become a visible cost driver. Cheapest mitigation short of full checkpointing: cache LLM outputs keyed by `(agent_tasks_id, phase)` so retries read from cache instead of re-calling the LLM. Checkpointing proper is the endgame.

### Separate Render background-worker service (vs. embedded Graphile inside NestJS API)
- **Chose:** `apps/server` (NestJS API) and `apps/worker` (Graphile runner) as separate Render services sharing one codebase. Workers scale independently from API; process crashes don't cascade.
- **Passed on:** (a) Embedded — Graphile Worker runs inside the main NestJS process. Simpler deploy, shared connection pool, coupled failure modes. (b) Self-managed VM — more ops surface.
- **Why:** Render makes the separation nearly free (same codebase, two service configs). Isolation — a handler OOM doesn't take down the API. Independent scaling — add worker capacity without bloating API boxes. Same Graphile + Postgres for both; no additional infra.
- **Gives up:** One more service to deploy and monitor; slight config duplication.
- **Revisit if:** The separation overhead ever exceeds its benefits (unlikely with Render's model).

### Handler returns output + sources; backend commits (vs. handler writes directly)
- **Chose:** Handler function returns `{ output, sources, reingestIntoWiki? }`; worker's commit helper wraps artifact row write + source junctions + `agent_tasks.status='succeeded'` in one Postgres transaction at the end of handler execution.
- **Passed on:** Handler gets direct DB write access and commits its own writes.
- **Why:** Centralizes transactional-commit correctness (Chunk 2 C1) — handler is pure orchestration logic; worker is the only writer. Prevents partial-commit bugs in handlers. Unifies source junction routing in one place (backend switches on source `kind` to pick the right table). Handler is unit-testable in isolation: pass a ctx, assert the returned output + sources.
- **Gives up:** Handler can't do intermediate writes as it progresses (e.g., write progress updates to `agent_tasks`). That's explicitly deferred — no streaming / no progress updates at MVP.
- **Revisit if:** A future kind genuinely needs multi-phase commits (e.g., long-running research that streams intermediate findings). At that point, either introduce a handler-side transaction builder or switch to checkpointing (which Chunk 2 also deferred).

### Tagged-union source attribution (vs. per-kind handler return shapes)
- **Chose:** Handler returns `sources: HandlerSource[]` where each entry is a tagged union (`kind: 'url' | 'wiki_ancestor' | 'research_output' | 'transcript' | 'upload'` + kind-specific fields). Backend switches on the discriminator to write to the right junction table.
- **Passed on:** Handler returns per-kind source arrays (`cited_urls`, `cited_wiki_pages`, etc.) — the return shape depends on the kind's registry entry.
- **Why:** One uniform return shape across all handlers; validation via one zod union schema. Source kinds are a closed set across the system — the tagged union is the natural representation. Backend routing logic lives once in the commit helper, not per-kind.
- **Gives up:** Handlers can attach sources that don't make semantic sense for their artifact kind (e.g., a podcast handler attaching a `transcript` source when podcasts aren't transcript-grounded). Worth an assertion at commit time but not a big risk.
- **Revisit if:** N/A — tagged unions are the right primitive here.

### MVP source granularity: artifact-level (vs. per-subunit from day one)
- **Chose:** At MVP, all sources attach to the whole artifact — `research_output_sources(research_output_id, …)`. No per-subunit attribution (e.g., per-section of a research output). Tagged-union source type has room for optional `attachedTo: { kind: '…-subunit', subunitId: '…' }` to be added when first needed.
- **Passed on:** Per-subunit attribution from day one.
- **Why:** MVP research output is a single structured `findings` jsonb — no natural subunit IDs that the UI would want to cite at. Building per-subunit attribution now means deciding subunit ID schemes for a kind we haven't shipped yet. When a V1+ kind (podcast chapters, brief sections) genuinely needs per-subunit cites, the union type extends with an `attachedTo` field and the backend learns to route to a sub-table.
- **Gives up:** One day we'll extend the schema. If MVP research UX surfaces "cite this exact claim in this exact section," we'd need to retrofit.
- **Revisit if:** Research UX needs per-finding citations (instead of artifact-level "these sources contributed to this report"). Extend the HandlerSource union + add sub-tables for the affected kind.

### Conservative retry posture at MVP (vs. aggressive auto-retry)
- **Chose:** Low `maxAttempts` ceilings (1–2 total attempts = original + at most one retry), retries only on clearly-transient `RetryableError` (rate limit, timeout, transient network), `PermanentError` / `ValidationError` fail immediately. Prefer visible failure + user re-run over silent auto-recovery.
- **Passed on:** Aggressive auto-retry (3–5 attempts, broader error class coverage, longer exponential backoff). Industry default for background workers.
- **Why:** At MVP scale, a failed task surfacing to the user is recoverable (they can re-queue via the UI). A silently retried task that eventually succeeds after 3 attempts may have already re-paid significant LLM cost (transactional-commit idempotency, Chunk 2 C1) AND may leave the user confused about task state. Visible failures teach us what breaks and why; auto-retry can mask real issues.
- **Gives up:** More user-visible failures in normal operation. Users see "research failed, tap to retry" more often than with aggressive retry.
- **Revisit if:** Failure rate from transient causes is high enough to annoy users. At that point, widen retryable error classes and/or bump `maxAttempts` on specific kinds. Easy to dial up later; hard to roll back if users associate the product with "things silently doing weird stuff in the background."

### No metrics infrastructure at MVP (vs. Prometheus + Grafana from day one)
- **Chose:** No dedicated metrics stack. Queue depth, success/failure rates, latency, cost all derived from ad-hoc SQL over `agent_tasks` + `usage_events` via Supabase Studio. Sentry handles error volume alerts. PostHog (already in the stack for analytics + feature flags) becomes the metrics path V1+ via server-side events.
- **Passed on:** Prometheus + Grafana from MVP. StatsD + custom dashboards. OpenTelemetry metrics export.
- **Why:** At single-founder + MVP volume, ad-hoc SQL is faster to answer specific questions than standing up dashboards against future-unknown queries. Existing tools (Supabase Studio, Sentry, PostHog) cover 80% of needs without new infra. Metrics stacks are a real operational burden — prometheus scraping, retention config, Grafana dashboards to maintain — that deliver marginal value before N gets real.
- **Gives up:** No persistent historical trending at MVP. Can't answer "how has p95 research latency evolved over the last 3 months" easily until we have either longer-retained SQL history or a metrics backend. Aggregate alerting ("failure rate > 5%") is harder without a metrics layer — Sentry does per-error alerts but not aggregates out of the box.
- **Revisit if:** (a) Ad-hoc SQL becomes the bottleneck for operational questions. (b) Need for aggregate alerts grows. (c) Volume warrants dedicated dashboards. Natural V1+ move: instrument task lifecycle events to PostHog server-side; dashboards follow from there.

### Minimal-then-expand PII redaction (vs. aggressive redaction from day one)
- **Chose:** Pino transport layer redacts a minimal initial set of known-PII fields (user prompt content, LLM outputs in error paths, connector payloads). Expand the redaction list as we observe what's actually being logged.
- **Passed on:** Aggressive redaction of anything that smells like user content from day one.
- **Why:** Over-redaction makes debugging miserable — when a handler fails and the Sentry breadcrumb shows `[REDACTED]` where the actual input would help diagnose, you're stuck. Starting permissive with conservative logging discipline + tightening as leaks are observed preserves debuggability while bounding risk. Tests early-days, tightens pre-launch or pre-public-beta.
- **Gives up:** Some PII may make it to logs/Sentry in the interim. Mitigated by: (a) logs + Sentry both have access controls, (b) no public exposure, (c) we can tighten without data loss since old logs age out.
- **Revisit if:** A specific PII leak is observed (add field to redact list) or we approach any regulatory boundary (GDPR subject access request, SOC2 audit) where we need stronger guarantees upfront.

### No progress percent on long-running tasks (maybe ever)
- **Chose:** UI shows "Working on it…" or "Researching…" for `status='running'` tasks — no percentage complete, no ETA. Agent-assigned todos in the `in-progress` bucket give users sufficient visibility. Eventually may add stage-level phase text ("Searching the web…", "Analyzing results…") but not structured progress.
- **Passed on:** Per-task `progress_pct` column updated by handlers as they phase through; UI renders a progress bar.
- **Why:** Progress percent requires handler cooperation (phased reporting) + ETA math (how long is "finding sources" vs "drafting"? varies wildly). Implementation is real work for a UX that may not materially improve perception. Most users check out of the app for 30s while they wait, come back when the notification fires; fine-grained progress matters less than perceived "it's doing something."
- **Gives up:** On long research tasks (1-2 min) users staring at the screen see no motion. Might read as "stuck." Mitigations: animated indicator, stage text (even if not %-based), estimated-at-submit-time "~1 minute" hint.
- **Revisit if:** Users repeatedly complain about "is it stuck?" — at that point cheapest fix is stage text, not true progress.

### No mid-call task initiation in `generic` calls; trial-artifact exception during `onboarding`
- **Chose:** During `generic` calls, Muse cannot kick off agent_tasks mid-call. Requests get acknowledged conversationally ("I'll research that — you'll get a notification") and flow through fan-out's implicit-commitment path post-call. **Exception:** `onboarding` calls have a mid-call tool (`queue_trial_artifact`) that lets Muse insert agent_tasks rows during the call — by call end, trial artifacts are waiting on the user's home screen. Onboarding scaffolding instructs Muse to offer 1–3 such artifacts max.
- **Passed on:** (a) Mid-call task initiation everywhere — adds a second write path to maintain, narrows the "no writes during calls" invariant, introduces race conditions ("actually, don't"), more state to track. (b) No mid-call initiation anywhere including onboarding — loses the strong first-impression moment of "you finished onboarding and Muse already did some things for you."
- **Why:** Two different optimization targets. `generic` calls prioritize architectural simplicity + invariant cleanliness — post-call lag of 1–5 min for first task result is acceptable for ongoing usage. `onboarding` calls prioritize wow-factor — the user just spent time talking to a stranger; they need to see immediate value. Trial artifacts during onboarding deliver that immediacy without compromising the production invariant for the steady-state product.
- **Gives up:** Code-path duplication — the onboarding scaffolding has a tool that the generic scaffolding doesn't, and the server validates the call-type at the tool endpoint. Slight risk that future call-types (V1+ contextual / task-specific) will want the same exception; need to be deliberate about which call-types unlock mid-call writes.
- **Revisit if:** (a) Steady-state generic-call lag becomes a real pain point — flip to allow mid-call kickoff there too. (b) Onboarding trial artifacts don't move the needle on activation/retention — pull them and simplify back to no-exception.

### Gemini Live built-in Google grounding for MVP (vs. custom `search_google` tool with provider abstraction)
- **Chose:** Use Gemini Live's native Google search grounding (config-flag enablement at session init); Google handles search invocation, citations, and result-injection inside the model. No custom tool, no provider abstraction at MVP. Migration to a custom tool + abstraction layer flagged for V1+.
- **Passed on:** Building `search_google` as a server-implemented tool from MVP, behind an internal interface that could swap providers (Tavily, Brave, SerpAPI). Would give per-call observability + granular budget control + provider flexibility from day one.
- **Why:** Built-in grounding is a flag flip with zero implementation work + lower latency (no roundtrip through our server) + Google handles citation grounding natively. MVP cost discipline is preserved via the conservative-flag setting and per-session toggle. Building the abstraction now means an external API integration we don't strictly need to ship MVP.
- **Gives up:** Per-call cost visibility (grounding cost rolls into Live session bill, not into our `usage_events`). Granular budget enforcement (can't say "max 2 grounded searches per turn" — only on/off). Locked to Google as provider. Citations come in Google's format and need mapping into `wiki_section_urls` at ingestion time.
- **Revisit if:** (a) We want per-call cost attribution. (b) We want to swap providers (Tavily, Perplexity, Brave). (c) Fine-grained budget control becomes critical (e.g., users hitting unexpected web-grounding costs). At trigger, swap built-in grounding off + plug `search_google` tool from backlog spec.

### Skills deferred to V1 (vs. include in MVP)
- **Chose:** Slate Skills as a P0 backlog item for V1; do not include in MVP. Skills = context-aware capability suggestions the agent advertises based on what the user is currently doing (reviewing an artifact, looking at a page, etc.). Each Skill is a registered template that composes existing primitives — wiki write via fan-out, plugin invocation, or inline generation — without requiring new artifact infrastructure for lightweight cases.
- **Passed on:** MVP inclusion. The infrastructure cost is genuinely small (a `skillRegistry` module + extension to call-agent prompt Layer 4 + a small seed set). UX value is significant — solves the "users don't know what to ask for" prompting-skill barrier.
- **Why deferred:** Discipline on MVP scope. We've been steadily piling decisions to push things into V1+ to keep the MVP build focused; adding a new capability surface — even a small one — works against that discipline. Skills can ship in V1 as the first major UX-extension feature without affecting MVP foundation work. The architectural placement is clear (parallel to plugin registry, in Layer 4 of call-agent prompt) so V1 implementation has a known shape.
- **Gives up:** A meaningful first-impression UX wow-factor in MVP that would rely on contextual proactiveness. MVP Muse will offer existing plugins (research) when contextually relevant but won't have the lightweight composed-action suggestions Skills enable.
- **Revisit if:** N/A — slated for V1 work, not actually deferred. The "if" is just timing.

### Agent-scope skip-default is on substance, not repetition (vs. user-scope's "wait for re-mention")
- **Chose:** Agent-scope ingestion records substantive single-call observations on first instance; skip-default fires on low-substance / unanchored claims, not on "haven't seen this enough times yet." Subsequent calls evolve the record by confirming, refining, or tombstoning.
- **Passed on:** Mirror of user-scope's "skip if uncertain — the claim will return next call." Originally proposed as a parallel discipline; turned out to be self-defeating.
- **Why:** The agent's private wiki *is* the agent's only cross-call memory. Each call's Flash sees exactly what's been written before, nothing more. Skipping a first-call observation in hopes of "waiting to confirm a pattern" loses the data forever — no second call can recognize a repeat of something that was never written down. Pattern recognition emerges *because* the agent records substantive observations promptly, not despite it.
- **Gives up:** Some MVP-period agent-wikis will accumulate observations that turn out to be one-off or wrong. That's the cost of being able to evolve: tombstoning stale observations is part of the natural editing flow as understanding refines. Without first-instance recording, there's no understanding to refine.
- **Revisit if:** Observation noise dominates value (agent-wikis become so cluttered with one-offs that future Flash calls struggle to distinguish signal from noise). Mitigations short of changing the rule: tighten the "substance" bar in the prompt, periodic agent-side lint pass that prunes stale observations, harder volume cap.

### Connectors as stateful first-class citizens (vs. just 3rd-party integrations)
- **Chose:** `connectors` table per user per service, holding OAuth state, scopes, and capability advertisements. Plugins declare `required_connectors`; UI surfaces "connect your Google account" prompts when capabilities are missing.
- **Passed on:** Treating integrations as implementation details of specific plugins (email plugin manages its own OAuth, calendar plugin manages its own, etc.).
- **Why:** Multiple plugins share the same underlying connector (email drafting + email ingest + contacts-from-email all want Google auth once). Separating connectors from plugins prevents duplicated OAuth flows and gives the user a coherent "integrations" surface.
- **Gives up:** Additional table + registry + UX surface — materially more plumbing than if we just baked integrations into plugins.
- **Revisit if:** Connector sharing across plugins turns out to be rare in practice, making the abstraction overkill.

---

### LLM field names match DB column names
- **Chose:** LLM emits `agent_abstract`, `abstract`, `content`, `title`, `slug`, etc. — the same names as the `wiki_pages` / `wiki_sections` columns they populate.
- **Passed on:** LLM emits `new_*` or similar prefixed variants with backend renaming at write time.
- **Why:** Eliminates a pointless rename step; prompt reads like a data contract; easier to grep LLM output against the DB schema.
- **Gives up:** Nothing meaningful.
- **Revisit if:** N/A.
