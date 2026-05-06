# SPEC — Pro fan-out prompt (KG parsing system instruction)

Status: **draft** — contradiction handling (stage 5) is the most fleshed-out section; other stages are stubs.

The Pro fan-out prompt is the large, cached, static system instruction that defines how the main ingestion LLM turns a transcript + preloaded page content into a structured write plan. It is the single most load-bearing prompt in the system: its quality determines how well the wiki compounds.

This spec is intended to evolve into the actual prompt text. Rules captured here are the ones Pro must follow to satisfy the architectural decisions made in `todos.md` and `tradeoffs.md`.

---

## Purpose & scope

Pro is responsible for stages 2–7 of the ingestion pipeline (see `notes/ingestion-pipeline.md`):

- Claim extraction from the transcript
- Per-claim noteworthiness filter
- Routing + entity resolution (constrained to Flash's candidate set)
- Contradiction detection
- Section write set + abstract regeneration
- Source attribution

Pro does **not** handle candidate retrieval (Flash, stage 1) or the transactional DB commit (backend, stage 8).

---

## Input / output contract

See `notes/ingestion-pipeline.md` for the full shape. Summary:

**Input:** turn-tagged transcript + `new_pages` plan from Flash + the fully-joined JSON representation of each candidate `touched_page` (including `agent_abstract`, `abstract`, and the ordered `sections` array with ids, titles, contents).

**Output:** JSON with top-level `creates`, `updates`, `skipped` arrays. Each `update` references sections by id (keep-by-id / update-by-id-with-content / create-by-title); sections currently in DB but absent from the list are tombstoned. Each create/update carries a regenerated `agent_abstract` (required) and optional `abstract`.

---

## Prompt structure (section outline)

Proposed order for the system instruction:

1. **Identity & role** — Audri as disciplined wiki maintainer
2. **Wiki ontology primer** — page types, scopes (user-only for Pro), hierarchy, sections, `agent_abstract` vs `abstract`
3. **Input contract description** — what the transcript + candidate pages look like
4. **Decision rules** (the meat — this spec covers this area)
5. **Output contract + hard rules** (JSON shape, citation discipline, invariants)
6. **Worked examples**

---

## Decision rules

### 4.1 Claim extraction

Read the transcript and identify discrete factual claims. The extracted claim set feeds stage 3 (noteworthiness) and stage 4 (routing).

#### Atomic granularity

A claim is **one subject + one predicate**. Compound utterances split into atomic claims:

- "Sarah moved to Portland and started a new job at Google"
  → ["Sarah moved to Portland", "Sarah started a new job at Google"]
- "I had coffee with Alex and we talked about Consensus"
  → ["I had coffee with Alex", "Talked with Alex about the Consensus project"]

Atomic granularity simplifies downstream stages: each claim can skip or write independently; contradiction detection evaluates one predicate at a time; source attribution attaches the relevant turn slice to each claim.

The atoms aren't emitted in the output — they're an internal reasoning unit. The output is section writes, aggregated per page.

#### Implicit commitment extraction

When a surface claim contains a commitment pattern, extract BOTH the surface fact AND an implicit todo claim:

- "I told Alex I'd send him the paper"
  → surface: "Promised Alex I'd send him the paper" → routes to `alex-*`
  → implicit todo: "Send Alex the paper" → routes to `todos/todo`

**Commitment patterns** (explicit, not fuzzy):

- "I'll do X" / "I will do X" / "I'm going to do X"
- "I told [person] I'd do X"
- "Remind me to do X"
- "I should do X" — only when stated as commitment
- "I need to do X" — only when stated as commitment

**NOT commitments:**

- "I might do X" — speculation (see §4.5)
- "I would do X if Y" — hypothetical (see §4.5)
- "I would have done X" — counterfactual
- "I wanted to do X" — past intent, not current commitment

The implicit todo is a multi-target write (rule 1 of §4.3). Flash is responsible for flagging `todos/todo` as a candidate when the transcript contains commitment patterns. If Flash misses it, the implicit todo is dropped per the §4.3 no-candidate-skip rule — acceptable MVP loss.

#### Speaker attribution

Claims are attributed to the speaker. The user's speech becomes claims about the user (or about entities they mention). **Audri's speech is NOT a source for claims** — Audri cannot author KG content from its own utterances. Restating facts back to the user does not create new claims.

This is an invariant, not a heuristic: without it, ingestion becomes a closed loop where Audri's inference during a call could be written into the user's KG as if the user said it.

### 4.2 Per-claim noteworthiness

For each claim extracted in stage 2, decide: proceed to routing, or drop into `skipped`.

#### Worth writing

A claim is noteworthy if it would change Audri's understanding of the user, a tracked entity, or the world. Specifically:

- **Facts** about tracked entities — state changes, attribute updates, events, biographical details.
- **Stated commitments or intents** — "I'll do X", "I want to Y" with enough specificity to be actionable.
- **Goals** — articulated aspirations, milestones, target outcomes.
- **Preferences and opinions** stated deliberately and substantively — "I prefer X over Y because Z".
- **Decisions** — choices made, paths committed to.
- **Self-disclosure / belief revision** — "I'm starting to think...".
- **New entities** worth tracking — a person, project, org, or concept.
- **Significant events** — meetings, transitions, milestones.

#### Worth skipping

- **Social pleasantries** — greetings, sign-offs, niceties.
- **Conversational scaffolding** — "let me think", "okay so", "as I mentioned".
- **Filler / disfluencies** with no informational content.
- **Restated facts already in the candidate pages** — the page already says it; no new information. Drop silently; do not add a Timeline entry like `**Current** — (still true)` to mark recency. Acceptable failure mode: if Pro misclassifies a new nuance as "already in the wiki," the nuance is lost. The risk is judged smaller than the noise cost of recency-marker entries.
- **Vague mentions** — too unspecific to inform anything ("Sarah said something about work").
- **Generic aspirations** without specificity, target, or commitment ("I should exercise more").
- **Speculation, hypotheticals, unclear-subject claims** — already covered in §4.5.

#### Threshold heuristic

When in doubt, **skip**. The wiki suffers more from noise than from missed claims — a missed claim usually returns in another conversation; a noisy claim pollutes search and inflates inference cost permanently.

A useful test the prompt can apply: *would a thoughtful reader of the wiki six months from now gain anything from this claim?* If no clear yes — skip.

#### Per-type bar adjustments

- **`profile` pages** — *higher* bar. Profile content should be settled and significant, not in-flight thinking. Speculative attitudes go to `note` or get skipped.
- **`todo` pages** — *lower* bar. Capture commitments aggressively; an extra todo is easy to dismiss, a missed one is friction.
- **`note` pages (when used)** — *lower* bar. Notes are ephemeral by nature and less load-bearing.
- **All other types** — default bar.

#### Output discipline

Every skipped claim appears in the output's `skipped` array with a brief `reason`. This gives observability into what fan-out chose not to write — load-bearing for evals and prompt iteration.

### 4.3 Routing

For each retained claim from stage 3, decide which candidate page(s) it lands on. The candidate set is fixed: Flash's `touched_pages` (existing) and `new_pages` (proposed creates). Pro cannot route to pages outside this set.

#### Five routing decisions

For each claim, in order:

1. **Multi-target check.** A single claim may legitimately touch multiple candidates. "Sarah and I are starting Consensus together" touches `sarah-chen` (existing) AND `consensus` (proposed new). Route to all candidates the claim materially informs. Each target gets the claim phrased from its own subject's perspective.

2. **Existing-candidate match.** If the claim's subject corresponds to an existing `touched_pages` slug, route there. Use aliases, contextual disambiguation, and the page's `agent_abstract` to confirm match. When the candidate set contains multiple plausible matches (e.g., two Sarahs), use contextual cues to pick one; if ambiguous, skip with `reason: "ambiguous subject across candidates"`.

3. **New-candidate match.** If the claim introduces an entity Flash flagged in `new_pages`, route to that proposed create. Pro may override Flash's proposed `type` if the transcript makes a different choice clearer (e.g., Flash said `concept`, transcript clearly establishes it's a `project`). The override is silent — no need to flag.

**Type-bucket allow-list — load-bearing.** The wiki has exactly **three** legitimate top-level type-organized hierarchies, all seeded at signup:
- `profile` (with on-demand sub-pages like `profile/goals`, `profile/work`, etc.)
- `todos` (with status buckets `todos/todo`, `todos/done`, etc.)
- `projects` (with individual project pages as direct children)

For every other page type (concept, person, place, org, source, event, note), **there is no type-bucket parent**. Pro must never invent or use parents like `concepts`, `places`, `people`, `events` — those buckets are explicitly *not allowed to exist*. Setting `parent_slug` is a SEMANTIC choice, not a type-categorical one.

**Top-level pages are RARE.** The bar is HIGH: emit `parent_slug: null` ONLY when the transcript explicitly indicates the user wants top-level treatment. Almost everything has a natural home under one of the seeded roots — the user's wiki is organized around dimensions of their life, and almost every entity fits somewhere. Heuristics in priority order:

- A new project → `parent_slug: "projects"` (default), or a more specific parent if obvious (a sub-project under its parent project).
- A new todo → `parent_slug: "todos/todo"` (or a different status bucket if the user specified one).
- A new sub-profile area → parent is `profile`.
- A new concept developed in a project's context → parent is that project.
- A new person → default `profile/relationships` (or non-canonical `profile/people` if the user uses that framing; or a project slug if the person is primarily project-relevant).
- A new organization → `profile/work` if work-related; non-canonical `profile/communities` if community/social; project slug if project-specific.
- A new standalone concept / interest / book → default `profile/interests`.
- A new place / source / event / note → `profile/interests` is the broad fallback for user-relevant content; pick a more specific profile sub-page if context warrants.
- Genuinely orphan content with no clear home → pick the closest profile-area parent rather than null. The Live Agent should have asked the user mid-call; if it didn't, bias toward `profile/interests` for ideas/topics, `profile/relationships` for people.
- `parent_slug: null` ONLY when the transcript explicitly directs top-level treatment.

When `parent_slug` references another create from the same response, order creates parent-before-child in the array so the backend's lookup resolves correctly.

**Flash provides a hint; Pro may silently override.** As of the v0.1.1 prefilter work, Flash emits `proposed_parent_slug` on every new_pages entry, applying the same priority order. Pro defaults to Flash's hint and may silently override when transcript content makes a different choice clearer (same precedent as the existing `type` override). End-to-end priority: explicit user direction in transcript > Pro's content-grounded judgment (silent override) > Flash's hint > Pro's default heuristics. See `tradeoffs.md` → "Pro silently overrides Flash's `proposed_parent_slug`" for the design rationale.

**Explicit user direction overrides heuristics.** If during the call the user told Audri where to file something ("nest this under Consensus", "make it top-level", "put it under my goals"), the transcript carries that direction. Pro respects it over its own semantic inference. The Live Agent's "ask when ambiguous" behavior (see `system-prompt.ts` and `specs/conversational-routing.md`'s Autonomy principle extended to structural intent) is the upstream half of this contract; Pro is the downstream half.

**2026-05-06 incident — what this rule prevents.** A call about creating a new project "Consensus" with sub-topics "Social Technology" and "Interdependence" produced: a Consensus page parented under an invented `Projects` bucket (correct now that `projects` is seeded — but at the time, Pro hallucinated it), and the two sub-topic concepts filed under an invented `Concepts` top-level bucket instead of nesting under Consensus. Both failure modes are blocked by the rule above: `concepts` is not a legitimate type-bucket; semantic nesting (concept under its parent project) is the correct pattern.

4. **No candidate fits → skip.** If a claim's subject doesn't correspond to any existing or proposed candidate, skip the claim. Add it to `skipped` with `reason: "no matching candidate"`. Do NOT invent a new entity outside Flash's `new_pages` plan. MVP scope — see §6.4 of the spec / `notes/ingestion-pipeline.md` for refactor paths if Flash recall becomes a problem.

5. **Premature-create guard.** Even when Flash proposed a new page, Pro may decide there is insufficient signal to merit creating it. Heuristic: a single passing mention with no substantive claim attached is not enough. Drop from `creates`; add a `skipped` entry with `reason: "insufficient signal for new page"`. Flash will re-flag the entity if it surfaces again with more substance.

#### Empty-update suppression

If, after stages 2–3, Pro has no meaningful claim to write to an existing candidate from `touched_pages`, omit it from `updates` entirely and add it to `skipped` with `reason: "no substantive claim on re-read"`. Do not emit an `update` entry that only changes `agent_abstract` cosmetically.

**Exception — hierarchy moves.** If the only operation on a page is a `parent_slug` change directed explicitly by the user, the update is NOT empty and MUST NOT be suppressed. The move IS the meaningful change. See "Hierarchy moves on existing pages" below.

#### Hierarchy moves on existing pages

When the user explicitly directs a move during the call ("move X under Y", "put X under my goals", "make X top-level", "nest these under Consensus"), Pro emits an `update` for X with the new `parent_slug`:

- `parent_slug` set to a string → move under that slug. The slug must resolve to either an existing user-scope page or another `create` from this same response.
- `parent_slug` set to `null` → move to top-level (parent_page_id becomes null).
- `parent_slug` field OMITTED → no change to the page's existing parent.

Hierarchy moves are metadata-only updates — Pro OMITS the `sections` field entirely (the page's existing sections are left untouched). Pro must NEVER emit `sections: []` for a move-only update — that would tombstone every existing section on the page. `agent_abstract` is still required.

**Only act on EXPLICIT user directives.** Don't infer moves from indirect cues; "I've been thinking about X in the context of Y" is content, not a move directive. Don't propose moves on Pro's own initiative; the user is the authority on structural choices.

If a move directive references multiple pages ("move A and B under C"), Pro emits one update per moved page. If C is itself a new page being created in this same response, Pro orders its output so C appears in `creates` BEFORE the moves in `updates` reference it.

Flash is responsible for flagging both the source page(s) being moved AND the target parent (or proposing the target as a new_page if it's a new entity); Pro depends on having both ends in the candidate set. See `specs/flash-retrieval-prompt.md` for Flash's "Move patterns" rule.

#### Section creation on updates

When a routed claim has a clear target page but doesn't fit any existing section on that page, Pro must CREATE a new section rather than skipping. The section operations schema supports it — `{ title, content, snippets }` with no `id` triggers a backend insert.

Skipping is for irrelevance, restatement, or already-covered content. It is NOT a fallback for "no existing section fits." Made concrete by the **2026-05-02 incident**: the user explicitly said "make a note in Audri's backlog about X" on a page with no Backlog section; Pro skipped because no fitting section existed. Correct behavior: create a `title: "Backlog"` section containing the new note.

When the user explicitly directs a write to a target ("make a note in X", "add this to Y", "put this under Z"), Pro must always write — creating a new section if needed. New section titles should be specific and informative ("Backlog", "Decisions log", "Open questions about X", "Risks", "Next steps") — not generic labels like "Notes" or "Other".

#### Multi-target phrasing

When a claim touches multiple targets (rule 1), each target's section content reflects the claim from that target's perspective:

- On `sarah-chen`: "Started a new project, Consensus, with [the user]."
- On `consensus`: "Joint project between [the user] and Sarah Chen."

The two writes are not literal copies. The `snippets` array on each section write attaches the same `turn_id` (the underlying transcript passage is shared) but the rendered claim differs by perspective.

### 4.4 Contradiction handling — *fully specified*

This is where the Timeline contradiction-handling behavior from `todos.md` §4 is operationalized. (The "Evergreen" half of the earlier Evergreen/Timeline dichotomy dissolved with the sectioned data model — default page shape is just ordinary sections; Timeline is only added when a contradiction arrives.)

#### 4.4.1 What is a contradiction

A claim contradicts existing content when two claims about the same subject cannot simultaneously be true.

**Contradictions (1:1 attributes):** current residence, primary job, employer, marital status, current role, age, physical location at a moment in time — any attribute a subject has exactly one of at a time.

**Additive claims are NOT contradictions:** interests, hobbies, skills, goals, friendships, projects, places visited, books read, topics followed. A subject may have many of these simultaneously. Additive claims are appended to the relevant section in-place; no Timeline involvement.

**Subjective / evolving claims (default to Timeline):** opinions, beliefs, attitudes, self-assessments, preferences, relationship dynamics, emotional states. Even if not strictly 1:1, preserving evolution is more valuable than collapsing it.

**Ambiguous cases → default to Timeline.** It is safer to over-classify as Timeline than to lose evolution context.

#### 4.4.2 Two shapes that look like contradictions but aren't

**Refinement — update in-place, no Timeline.** A new claim specifies or narrows an earlier one.
> "Sarah works at a startup" → "Sarah works at Consensus, a distributed-consensus startup."

Not a contradiction — precision. Replace the broader claim with the more specific one in its current section.

**Correction — overwrite wholesale, no Timeline.** The user flags a prior statement as incorrect.
> "I misspoke earlier — Sarah lives in Denver, not Boulder."

Overwrite wholesale. A correction has no history worth preserving.

#### 4.4.3 The Timeline-split operation

When Pro detects a contradiction against an existing claim:

1. **Locate the superseded claim** in its current section. May live in a named section, in another bullet within Timeline, or in the lead content.
2. **Ensure Timeline exists.** If the page has no Timeline section, create one as the first section with `title: "Timeline"`.
3. **If Timeline already has a `**Current**` entry for this attribute,** demote it to `**Past**` (dated if possible) before inserting the new `**Current**`. Never leave two `**Current**` entries for the same attribute.
4. **Add the new claim as the first Timeline bullet:**
   `- **Current** — <new claim>`
5. **Add the superseded claim as the next Timeline bullet:**
   `- **Past** — <superseded claim>` — use a specific date (`**March 2025**`) if the transcript or prior context makes it inferable; otherwise `**Past**`.
6. **Re-emit the source section with the superseded claim removed.** The non-contradicted content of that section stays.
7. **Regenerate `agent_abstract` (and `abstract` if present)** to reflect the current state — i.e., the post-contradiction truth, not the superseded one. Abstract regeneration is unconditional on page writes; it always operates on current truth.

#### 4.4.4 Timeline structure — flat, not grouped

Timeline entries are a flat newest-first bullet list. Do not introduce sub-groupings (by attribute, by topic, by year). If a Timeline appears to need sub-grouping, that is a signal the page's content belongs on separate pages — escalate by creating a child page via hierarchy, not by adding sub-structure within the section.

This principle is load-bearing, not just ergonomic: sub-grouping collides with the rule that sections have one `title` and one `content` string, and it conflates structural hierarchy (which lives at the page level) with temporal ordering (which lives inside the Timeline section).

#### 4.4.5 Timeline annotation format

Every Timeline bullet begins with a bold temporal marker, followed by an em-dash, followed by the claim:

- `- **Current** — <claim>`
- `- **Past** — <claim>`
- `- **April 2026** — <claim>` — specific month when inferable
- `- **Since March 2025** — <claim>` — duration when inferable
- `- **2024** — <claim>` — fall back to year if more precision isn't available

Pro should attempt to infer specific dates from the transcript (absolute dates, relative expressions like "last month" resolved against the call timestamp, inferences from context). When inference isn't possible, fall back to `**Past**` or `**Current**`.

### 4.5 Claims to skip entirely

- Speculation: "I might move to Portland someday." Not a claim, it's speculation.
- Hypotheticals: "If we did X, Y would happen."
- Unclear subject: "They're moving" with no resolvable antecedent.
- Restatement of already-captured facts (with no new information).

Skipped claims go into the output's `skipped` array with a brief `reason`.

### 4.6 Source attribution

Every `create` section and every `update` section that carries a content change must include a `snippets` array with one or more `{ turn_id, text }` entries tying the write to a transcript passage. Sections kept-as-is (referenced only by id, no content change) do not require new snippets.

Pro must not fabricate turn IDs — every `turn_id` must appear verbatim in the input transcript.

---

## Output contract — hard rules

- Output is a single JSON object with keys `creates`, `updates`, `skipped`. No trailing commentary.
- `agent_abstract` is required on every `create` and `update`.
- `abstract` is optional; omit the field rather than emit an empty string.
- Sections in an `update`'s `sections` array use uuid ids for existing sections; new sections omit the id.
- Never invent slugs in `updates` — an update's `slug` must match a candidate from `touched_pages`.
- Never cross scopes — Pro operates only on user-scope pages. The `agent` scope is off-limits.
- Never emit `user_id`, `page_id`, `section_id`, `scope`, `parent_page_id`, or timestamp fields — these are backend concerns.
- Timeline section, when present, must appear first in the `sections` list (prompt convention; backend may enforce).

---

## Worked examples — *stub, to flesh out*

To be added: 2–3 full before/after examples covering

- **Pure contradiction** — Sarah moved Boulder → Portland. Show the Timeline section being created; the old residence claim removed from its original section; `agent_abstract` regenerated.
- **Refinement** — "Sarah works at a startup" → "Sarah works at Consensus." In-place update, no Timeline.
- **Correction** — "I misspoke, it's Denver not Boulder." Wholesale overwrite, no Timeline.
- **Additive** — Sarah took up guitar. Appended to the Interests section; no Timeline.
- **Serial contradictions** — Boulder → Denver → Portland over three calls. Demotion of existing `**Current**` to dated `**Past**`.

Each example should show the full before-JSON and after-JSON so Pro can pattern-match on the exact transformation.

---

## Open questions

- **Claim granularity** — does Pro treat "Sarah moved to Portland and started a new job" as one claim or two? Affects `skipped` reasons and source attribution.
- **Implicit commitments** — how aggressively does Pro mine the transcript for action items? Too aggressive and the user is bombarded with notifications; too conservative and we miss obvious todos.
- **Restated facts** — skip silently (lose recency signal) or append to Timeline as `**Current** — (restated)` (noise)?
- **Attribute identity** — when demoting an existing `**Current**` to `**Past**`, how does Pro know two Timeline entries are about the *same* attribute (both about residence) vs. different attributes (one about residence, one about job)? For MVP, rely on Pro's semantic judgment; empirically evaluate.
- **Date inference failures** — if Pro infers a wrong date, the Timeline becomes misleading. Is it better to prefer `**Past**` conservatively and only date when the transcript is explicit?

---

## Related decisions

- `todos.md` §4 — Timeline section contradiction-handling decision
- `todos.md` §3 — sectioned page data model (makes this whole mechanism feasible)
- `tradeoffs.md` — sectioned pages + `agent_abstract`/`abstract` naming
- `notes/ingestion-pipeline.md` — full pipeline context for this prompt's role
- `specs/agents-and-scope.md` — why Pro is user-scope-only and agent-scope writes run in a separate Flash-driven pass
