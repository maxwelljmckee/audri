# SPEC — Pro fan-out prompt (KG parsing system instruction)

Status: **active** — last rewrite 2026-05-15 (judgement-over-worthiness + named-entity-as-pages + agent-turn capture). Contradiction handling (stage 5) is the most fleshed-out section; other stages have evolved alongside the prompt.

The Pro fan-out prompt is the large, cached, static system instruction that defines how the main ingestion LLM turns a transcript + preloaded page content into a structured write plan. It is the single most load-bearing prompt in the system: its quality determines how well the wiki compounds.

This spec is intended to evolve into the actual prompt text. Rules captured here are the ones Pro must follow to satisfy the architectural decisions made in `todos.md` and `tradeoffs.md`.

## Guiding philosophy (2026-05-15 rewrite)

The fan-out prompt is governed by four principles that supersede prior "worthiness-filter" framings:

1. **Trust hierarchy: more > less > false.** Bias to capture. Missing capture is bad; over-capture is acceptable; invention is unacceptable. Sparse named-entity stubs are the intended outcome of "I'd rather have a thin page than no page."

2. **Page vs section/bullet — tiered priority.** (Revised 2026-05-15 after the proactive-stub overcorrection.) Decision rules in priority order:
   1. **Explicit current-call user direction** ("make a page for X" / "add as bullet") — respect it.
   2. **Established precedent for the context** — wiki structure already follows a pattern (e.g., `reading-list` is all sub-pages, no bullet section) → follow it. Or page-level "Conventions" notes carry binding precedent.
   3. **Substance heuristic** — bare mention → bullet; paragraph → section; multi-paragraph → page. Don't spawn empty pages in anticipation of future content.
   4. **Promotion path** — `bullet → section → sub-page` as content develops across calls. Pro promotes on strong signal; doesn't demote.

   Live agent asks when ambiguous (Pro reads post-call, no chance to clarify). Under-spawn beats over-spawn — clutter is harder to clean than gaps are to fill.

3. **Agent turns are capturable when user intent is clear.** The strict "speaker-attribution invariant" is too conservative. When the user directs or accepts action on agent-enumerated content (recall flow: user asks, agent recalls, user says "save those") — those agent turns become the source for capture. Don't invent beyond what the agent actually said.

4. **Pro has no tools.** All search (wiki, transcripts, web) happens during the live call via the agent's tools (`search_wiki`, `search_transcripts`, `fetch_page`, `fetch_transcript`, `googleSearch`). Pro reads transcript + grounding URLs only. If a capability is missing in practice, the fix is to add a live-agent tool, NOT to give Pro retrieval.

These principles are encoded in the prompt's §2 (Capture vs skip), §"Named entities as pages" under routing, §"Agent turns capturable," and the input contract's "no tools" note.

**Manual retry signal:** when the user manually re-triggers ingestion from the transcript UI, the runtime prepends a `# manual_retry` block to the user message. Pro reads this as "lean harder toward capture" — they retried because they think something was missed. See `apps/worker/src/ingestion/pro-fan-out.ts` (manualRetryBlock).

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

> **v0.2 forward note (substrate landed 2026-05-09; populator not yet wired):** the `extracted_claims` table now exists as the per-claim audit trail. When the producer for this prompt is updated as part of v0.2 item #4 (agent-scope ingestion / Stage 3 of DP-7), each atomic claim should also produce an `extracted_claims` row with `status` (default `'supported'`), `confidence` (0–100 int when expressible, else NULL), `evidence[]` (free-form source-reference array — typical entries cite a transcript turn or URL plus a snippet), and bi-temporal fields (`recorded_at` defaulted, `valid_from` / `valid_until` set when the claim itself states a temporal range). The atoms-as-internal-reasoning model still holds for *section writes*; the new table adds a parallel persistent record. See `db-schema-plan.md` §13a for the full schema.

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

#### Speaker attribution — agent turns capturable on user direction

**Rewritten 2026-05-15.** Prior version was a hard invariant ("Audri's speech is NEVER a source"); this was too conservative and caused the 2026-05-14 reading-list incident where the user clearly directed re-saving books the agent had recalled, and Pro emitted zero writes by pattern-matching on speaker-attribution alone.

Revised rule:
- User speech is the **primary** source of claims.
- Agent speech is a **secondary** source — usable when the user directs or accepts action on what the agent said.

Capture patterns:
- ✅ User asks agent to recall → agent enumerates → user says "save those" / "re-add them" → capture the agent's enumeration.
- ✅ Agent proposes additive content → user accepts (explicit or continuation without contradiction) → capture.
- ✅ Agent does a googleSearch / search_wiki / search_transcripts lookup and speaks the result; user is informed by it → capture the looked-up content. Cited URLs flow via `grounding_sources`.
- ❌ Agent's reflective scaffolding ("so it sounds like…") with no user direction → not a source. Skip.
- ❌ Restated facts the user already said in the same call → not new content; original turns are the source.

**Don't invent beyond the transcript.** Capture what the agent SAID, not what the agent might have meant. If agent named four books, capture four — not a hypothetical fifth. Lookup results not spoken don't exist for ingestion.

The 2026-05-15 prompt rewrite folded the old "Authorized embellishment" three-test gate (Audri commits → user assents → reasonable from common knowledge) into this single softened rule.

### 4.2 Capture vs skip — judgement, not gating

**Rewritten 2026-05-15.** Prior version had long worth-writing / worth-skipping lists and a "when in doubt, skip" threshold heuristic. The new philosophy inverts that:

**Trust hierarchy:** more information > less information > false information. Bias to capture. When in doubt, write — phrased as best you can, on the most relevant candidate, possibly as a sparse stub. The wiki's value compounds with content; sparse pages don't help the user's future self think, but missing pages help even less.

**Explicit user directives ALWAYS override.** When the user directs an operation ("make a note that…", "remind me to…", "save those"), fulfill it. No worthiness check applies. The directive IS the signal.

**Skip — clearly not content** (compact list — the prompt names a handful, judgement covers the rest):
- Social pleasantries, conversational scaffolding ("let me think"), filler.
- Test / meta utterances ("ignore this, just testing the call").
- Meta-instructions to Audri about HOW to behave (not what to record).
- Restated facts already in candidate pages — drop silently. No `**Current** — (still true)` Timeline noise.

**Judgement examples** — the prompt walks through 6 worked cases (book added to reading list, ephemeral feeling tied to durable concern, pure ephemeral state, recall flow with agent-named items, multi-turn framework capture, speculation skip). These replace the prior "worth writing / worth skipping" lists and exist to make judgement-by-pattern-matching feasible.

**Per-type bar adjustments** (lightly weighted, judgement still rules):
- `profile` — slightly higher bar; profile content should be settled, not in-flight.
- `todo` / `note` / `braindump` — lower bar; forgiving homes for in-motion content.
- `project` / `concept` — low bar for substantive content; frameworks + reasoning capture richly.

**Ephemerality** is one judgement axis among many — handled inline in the worked examples rather than as its own section. The rule: ephemeral state anchored to a durable concern (e.g., "dreading Monday's review") captures against the durable target, not as standalone ephemeral content. Pure ephemeral state ("I'm hungry") skips.

**Output discipline:** every skipped claim still appears in the output's `skipped` array with a one-phrase `reason`. Load-bearing for evals + prompt iteration.

### 4.3 Routing

For each retained claim from stage 3, decide which candidate page(s) it lands on. The candidate set is fixed: Flash's `touched_pages` (existing) and `new_pages` (proposed creates). Pro cannot route to pages outside this set.

#### Five routing decisions

For each claim, in order:

1. **Multi-target check.** A single claim may legitimately touch multiple candidates. "Sarah and I are starting Consensus together" touches `sarah-chen` (existing) AND `consensus` (proposed new). Route to all candidates the claim materially informs. Each target gets the claim phrased from its own subject's perspective.

2. **Existing-candidate match.** If the claim's subject corresponds to an existing `touched_pages` slug, route there. Use aliases, contextual disambiguation, and the page's `agent_abstract` to confirm match. When the candidate set contains multiple plausible matches (e.g., two Sarahs), use contextual cues to pick one; if ambiguous, skip with `reason: "ambiguous subject across candidates"`.

3. **New-candidate match.** If the claim introduces an entity Flash flagged in `new_pages`, route to that proposed create. Pro may override Flash's proposed `type` if the transcript makes a different choice clearer (e.g., Flash said `concept`, transcript clearly establishes it's a `project`). The override is silent — no need to flag.

**Type-bucket allow-list — load-bearing.** The wiki has exactly **four** legitimate top-level type-organized hierarchies, all seeded at signup (v0.2 added braindump):
- `profile` (with on-demand sub-pages like `profile/goals`, `profile/work`, etc.) — **evergreen content about who the user IS**
- `todos` (with status buckets `todos/todo`, `todos/done`, etc.) — action items
- `projects` (with individual project pages as direct children) — **active work**
- `braindump` (sub-pages emerge on-demand as content clusters) — **unstructured / transient / exploratory thoughts**

For every other page type (concept, person, place, org, source, event, note), **there is no type-bucket parent**. Pro must never invent or use parents like `concepts`, `places`, `people`, `events` — those buckets are explicitly *not allowed to exist*. Setting `parent_slug` is a SEMANTIC choice, not a type-categorical one.

**Top-level pages are RARE.** The bar is HIGH: emit `parent_slug: null` ONLY when the transcript explicitly indicates the user wants top-level treatment. Almost everything has a natural home under one of the seeded roots. Heuristics — read in order, take the FIRST that fits:

1. A new project → `parent_slug: "projects"` (default), or a more specific parent if obvious.
2. A new todo → `parent_slug: "todos/todo"` (or a different status bucket if specified).
3. Project-scoped sub-content (concept, sub-project, doc clearly tied to an existing project) → that project's slug.
4. **Evergreen content ABOUT THE USER** (relationships, work, health, goals, life-history, interests, preferences, values, psychology) → `profile/<area>`:
    - A new person → default `profile/relationships` (or non-canonical `profile/people`; or a project slug if primarily project-relevant).
    - A new organization → `profile/work` if work-related; non-canonical `profile/communities` if social.
    - A new sub-profile area (e.g. `profile/finances`) → parent is `profile`.
5. **Transient / exploratory / unstructured thoughts** that aren't a project, aren't about-the-user, and aren't a task → `braindump` (or a `braindump/<cluster>` sub-page if Flash proposed one). Examples: "movies I want to watch," "half-baked ideas," "stuff I'm noodling on," one-off observations.
6. Genuinely orphan content with no clear home → bias toward `braindump` (transient/in-motion content) rather than stretching into `profile/interests` (which is for content the user has actually integrated into who-they-are).
7. `parent_slug: null` ONLY when the transcript explicitly directs top-level treatment.

When `parent_slug` references another create from the same response, order creates parent-before-child in the array so the backend's lookup resolves correctly.

**Flash provides a hint; Pro may silently override.** As of the v0.1.1 prefilter work, Flash emits `proposed_parent_slug` on every new_pages entry, applying the same priority order. Pro defaults to Flash's hint and may silently override when transcript content makes a different choice clearer (same precedent as the existing `type` override). End-to-end priority: explicit user direction in transcript > Pro's content-grounded judgment (silent override) > Flash's hint > Pro's default heuristics. See `tradeoffs.md` → "Pro silently overrides Flash's `proposed_parent_slug`" for the design rationale.

**Explicit user direction overrides heuristics.** If during the call the user told Audri where to file something ("nest this under Consensus", "make it top-level", "put it under my goals"), the transcript carries that direction. Pro respects it over its own semantic inference. The Live Agent's "ask when ambiguous" behavior (see `system-prompt.ts` and `specs/conversational-routing.md`'s Autonomy principle extended to structural intent) is the upstream half of this contract; Pro is the downstream half.

**2026-05-06 incident — what this rule prevents.** A call about creating a new project "Consensus" with sub-topics "Social Technology" and "Interdependence" produced: a Consensus page parented under an invented `Projects` bucket (correct now that `projects` is seeded — but at the time, Pro hallucinated it), and the two sub-topic concepts filed under an invented `Concepts` top-level bucket instead of nesting under Consensus. Both failure modes are blocked by the rule above: `concepts` is not a legitimate type-bucket; semantic nesting (concept under its parent project) is the correct pattern.

4. **No candidate fits → skip.** If a claim's subject doesn't correspond to any existing or proposed candidate, skip the claim. Add it to `skipped` with `reason: "no matching candidate"`. Do NOT invent a new entity outside Flash's `new_pages` plan. MVP scope — see §6.4 of the spec / `notes/ingestion-pipeline.md` for refactor paths if Flash recall becomes a problem.

5. **Premature-create guard.** Even when Flash proposed a new page, Pro may decide there is insufficient signal to merit creating it. Heuristic: a single passing mention with no substantive claim attached is not enough. Drop from `creates`; add a `skipped` entry with `reason: "insufficient signal for new page"`. Flash will re-flag the entity if it surfaces again with more substance.

#### Page vs section/bullet — explicit direction first, then precedent, then substance — *added 2026-05-15, revised same day*

**History note:** the first version of this rule (also 2026-05-15) prescribed "named entities → own pages always, sparse stubs allowed." That swung too far the other way of the original reading-list bug and produced its own failure mode: Pro spawned empty stub pages for every named entity mention (Plato's Republic doc ingestion produced 4 sibling empty stubs). The revised rule below uses a tiered priority chain instead of a single prescription. See `feedback_proactive_stub_overcorrection` memory.

When Pro is deciding how to capture a referenced entity (book, person, place, project, org, etc.), the decision rules apply in priority order — first match wins:

**1. Explicit current-call user direction.** "Make a page for X", "save each as separate pages", "add as a bullet", "put it under projects/consensus". The user told you the shape. Don't second-guess.

**2. Established precedent for the context.** When the user has previously directed a structural pattern for a given context, respect it on subsequent calls even when not restated. Sources Pro can read TODAY:
- **Visible wiki pattern.** If the candidate page's existing structure is consistent (e.g., `reading-list` only contains sub-pages of type `source`, no bullet-list section), infer the pattern and follow it. Pro already gets `touched_pages` fully joined — the children + section shapes are visible.
- **Page-level convention notes.** If the candidate page carries a section like "Conventions" or "Structure" describing the pattern, or if `agent_abstract` records the convention, treat it as binding precedent.
- **User-wide preferences (future).** A `profile/preferences` page or persona-level prefs substrate that records user-wide structural rules. Not yet plumbed; for MVP, the visible-wiki-pattern signal carries it.

The user can override precedent at any time by restating direction (rule 1). When the live agent records a new structural preference mid-call, the persistence should land somewhere Pro will see next time — see "Capturing precedents" note below.

**3. Substance-based promotion.** Absent direction or precedent, decide based on how much content is attached to the entity in this transcript:
- **Bullet** — a name + one short clause of context, no further development → list-item bullet within an existing section on the most natural page.
- **Section** — a paragraph or two of substantive content → section on the most natural page (or new section if no fitting one exists).
- **Page** — multi-paragraph block / sustained framing / rich content that warrants its own home → spawn the page with that content as its initial sections.

The bar for spawning a page is **content present right now**, not "this entity might accumulate content later." Empty stubs spawned in anticipation tend to clutter the wiki without delivering value.

**4. Content promotion path.** Content moves UP the hierarchy as it develops across conversations:

```
bullet in a section  →  dedicated section  →  dedicated sub-page
```

Pro promotes autonomously when current-call content materially develops a topic past what the existing container can hold:
- **Bullet → dedicated section.** A list bullet has grown into a paragraph + sub-structure → lift it out.
- **Section → dedicated sub-page.** A section has accumulated material covering multiple coherent facets of a distinct topic → create `{parent_slug}/{topic-slug}`, move the section's content into the new page, replace the original section with a short pointer + summary.

Promote only on strong signal. A second mention isn't automatic. Over-promotion fragments the wiki; under-promotion is reversible. Pro does NOT demote — user-directed only.

**Live-agent contract.** When the user is ambiguous about shape, the LIVE AGENT should ASK ("want this as its own page or a quick mention?") — not Pro (Pro reads post-call, no chance to clarify). If the agent didn't ask and the transcript is unclear, Pro falls back to rule 3 (substance heuristic). Better to under-spawn (recoverable) than over-spawn (clutter).

**Reading-list / Sapiens worked examples:**

- ✅ User: *"Add Sapiens to my reading list."* (no detail, no prior precedent) → bullet on `reading-list`. Rule 3 (substance heuristic — bare mention).
- ✅ User: *"Add Sapiens — and each book on that list should be its own page so I can take notes as I read."* → spawn `sapiens` page (sparse OK because explicit direction). Rule 1.
- ✅ User established "each book = its own page" in a prior call. Wiki shows `reading-list` already has `good-services-by-lou-downe` as a child page, no bullet-list section. User adds "Sapiens" in a new call with no extra detail → spawn `sapiens` page following precedent. Rule 2.
- ✅ User: *"I've been reading Sapiens — Harari's premise is that humans dominated other species via shared fictions. The cognitive revolution ~70k years ago. He divides it into four revolutions..."* → spawn `sapiens` page with sections capturing the framework. Rule 3 (substance is rich).
- ❌ User: *"Add Sapiens to my reading list"* + reading-list shows no prior pattern + no rich content → spawning a sparse `sapiens` page anyway, anticipating future content. This is the overcorrection failure mode.

**Capturing precedents (live-agent / persistence concern, not Pro's job).** When the user states a structural preference mid-call ("from now on, books always get their own page"), the live agent should ensure that preference is captured somewhere Pro can see on subsequent runs. MVP route: write the convention into the relevant wiki page's `agent_abstract` or as a "Conventions" section on the page itself. Future: a dedicated preferences substrate. Tracked in backlog (Dreams + per-page conventions).

Slug convention: prefer the simple slug (`sapiens`, `paris`). Trust Flash's `proposed_slug`; commit-side merge-on-conflict handles collisions.

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

#### Section update operations — explicit per-operation contract

Each entry in an update's `sections` array is a FULL state declaration for that section after the update lands. There are four operations — pick the shape that matches your intent. **If you pick the wrong shape, the wrong thing happens silently** (the commit phase doesn't validate semantics against the transcript). The **2026-05-17 "add to reading list" regression** was exactly this failure mode: Pro emitted KEEP-AS-IS shapes thinking they were updates, and the user's directive was dropped.

**1. KEEP-AS-IS** — preserve a section unchanged. Title stays, content stays, snippets stay.
```json
{ "id": "<existing-uuid>" }
```
ONLY use this when you want literally zero change. **It is NOT how you add a bullet, change a heading, or note that a section was "touched" by a claim.** Reach for it only to prevent tombstoning when you're updating sibling sections.

**2. UPDATE EXISTING — full content rewrite.** This is the shape for adding, changing, OR removing content from an existing section:
```json
{ "id": "<existing-uuid>", "content": "<FULL new section content>", "snippets": [...] }
```
The `content` field is the ENTIRE new section body — markdown, prose, lists, everything that should be in the section after the update. The commit phase REPLACES `content` wholesale; it does not append, patch, or diff.

- **Adding a bullet** to a 12-bullet list section → re-emit all 13 bullets (12 originals + 1 new) in `content`.
- **Editing a sentence** → re-emit the section with the edited sentence in place, all unchanged prose preserved verbatim.
- **Deleting a bullet / paragraph** → re-emit without the deleted text; everything else preserved.
- **Reordering** → re-emit in the new order.

Optional `title` to rename the heading (re-emit the new title). Optional `cited_urls` for new grounding citations. Always include `snippets` tying the change to transcript turn_ids.

**3. CREATE NEW SECTION ON THE PAGE** — add a new section to an existing page:
```json
{ "title": "<heading>", "content": "<markdown>", "snippets": [...] }
```
No `id` — the backend assigns one. Title strongly encouraged (see §"Section content depth"). Used when the routed claim doesn't fit any existing section.

**4. REMOVE A SECTION** — there is no remove shape. To remove, OMIT the section from the `sections` array. The commit phase tombstones any existing section absent from the list. **Corollary: list every section to keep — `{id}` for sections with no change.**

---

**Worked example — adding a book to a reading list:**

Current `reading-list` state in `touched_pages`:

```
sections:
  - id: 681a4f88-..., title: null,            content: "..."
  - id: e6a937cf-..., title: "Books to Read", content: "- Good Services by Lou Downe\n- Sapiens by Yuval Noah Harari\n- Thinking, Fast and Slow"
```

User says: "Add The Art of Gathering by Priya Parker to my reading list."

✅ CORRECT:

```json
{
  "slug": "reading-list",
  "agent_abstract": "A reading list of books to read or currently reading.",
  "sections": [
    { "id": "681a4f88-..." },
    {
      "id": "e6a937cf-...",
      "title": "Books to Read",
      "content": "- Good Services by Lou Downe\n- Sapiens by Yuval Noah Harari\n- Thinking, Fast and Slow\n- The Art of Gathering by Priya Parker",
      "snippets": [{ "turn_id": "turn-1", "text": "add The Art of Gathering by Priya Parker to my reading list" }]
    }
  ]
}
```

The first section is kept-as-is via `{id}`. The "Books to Read" section is fully re-emitted with all original bullets plus the new one. Snippets tie the change to the transcript turn that licensed it.

❌ WRONG (the 2026-05-17 regression shape):

```json
{
  "slug": "reading-list",
  "agent_abstract": "...",
  "sections": [
    { "id": "681a4f88-..." },
    { "id": "e6a937cf-...", "title": "Books to Read" }
  ]
}
```

Both shapes are KEEP-AS-IS. Nothing changes. The directive is silently dropped, often paired with a misleading `skipped: ["Captured as bullet on reading-list per existing page pattern"]` — claiming work that didn't happen, which is the worst failure mode.

**Rule of thumb:** if you intend ANY change to a section's content, you MUST include `content` with the FULL new body. `{id}` alone means "this section is unchanged and I'm only listing it to prevent tombstoning."

**Anti-self-deception check (added 2026-05-17 after recurrence on both voice + text paths).** Before submitting the JSON, Pro must scan its own `skipped` array. If any `reason` contains verbs that assert capture — "captured as bullet", "added to", "noted in", "saved to", "appended", "recorded on", "tracked" — that's a **contradiction** with the schema: `skipped` means NOT written. Either the claim was actually written (in which case it belongs in `creates` or `updates` with concrete `content`, NOT `skipped`) or it wasn't (in which case the reason should reflect that honestly, e.g. "no fitting section without restructuring"). The commit phase doesn't read `skipped` reasons — it only writes what's in `creates` and `updates`.

The system prompt embeds this check at the top (§"Section update mechanics") so the model sees it before routing decisions. The commit phase (`apps/worker/src/ingestion/commit.ts` → `detectLyingSkippedFailure`) also hard-fails when it sees the lying-skipped pattern paired with no-content updates — converts the silent zero-write into a `partial` ingestion that surfaces the retry banner. Both layers exist because the prose-only rule kept getting overridden by the model's prior; needed structural enforcement to back it up.

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
