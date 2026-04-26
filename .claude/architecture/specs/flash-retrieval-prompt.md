# SPEC — Flash candidate-retrieval prompt (stage 1 of fan-out)

Status: **draft** — decision rules locked; prompt-text drafting + worked examples + evals remain.

The Flash retrieval prompt is the small, cached, static system instruction that drives stage 1 of the ingestion pipeline. It reads a transcript + a compact index of the user's existing wiki and emits a candidate set: which existing pages might need updating, and which new pages might need creating. Pro then operates on the joined content of those candidates.

Flash is also the implicit noteworthiness gate: an empty candidate set means "nothing here is worth ingesting," and Pro never runs.

This spec is intended to evolve into the actual prompt text. Rules captured here are the ones Flash must follow to satisfy the architectural decisions made in `todos.md` and `tradeoffs.md`.

---

## Purpose & scope

Flash is responsible for stage 1 of the ingestion pipeline (see `notes/ingestion-pipeline.md`):

- Read the full transcript
- Compare against a compact wiki index
- Emit `touched_pages` (existing pages that may need updates)
- Emit `new_pages` (proposed new pages with seed names)
- Implicitly gate noteworthiness — empty arrays = no fan-out

Flash does **not** extract claims, evaluate per-claim noteworthiness, route writes, detect contradictions, or write to the DB. Those are Pro's job (stages 2–7) or the backend's (stage 8).

---

## Input / output contract

See `notes/ingestion-pipeline.md` for the full shape. Summary:

**Input:**
- Turn-tagged transcript (full call), with explicit `User:` / `Muse:` speaker labels.
- Compact wiki index — all of the user's `wiki_pages` rows, each rendered as `{slug, title, type, parent_slug, agent_abstract}`. No section content. No `abstract`.

**Output:** JSON with two top-level arrays.

```json
{
  "touched_pages": [
    { "slug": "sarah-chen" },
    { "slug": "consensus" }
  ],
  "new_pages": [
    { "proposed_slug": "alex-rivera", "proposed_title": "Alex Rivera", "type": "person" },
    { "proposed_slug": "ml-reading-group", "proposed_title": "ML Reading Group", "type": "project" }
  ]
}
```

Empty arrays (`{ "touched_pages": [], "new_pages": [] }`) are the implicit noteworthiness gate — backend skips Pro entirely.

---

## Prompt structure (section outline)

Proposed order for the system instruction:

1. **Identity & role** — Muse as a fast, recall-biased candidate-finder
2. **Wiki ontology primer** — page types, hierarchy, how to read the index
3. **Input contract description** — what the transcript + index look like
4. **Decision rules** (the meat — this spec covers this area)
5. **Output contract + hard rules** (JSON shape, schema invariants)
6. **Worked examples**

---

## Decision rules

### 4.1 Reading the index

Flash receives the full wiki index in its system context — every page the user owns, as `{slug, title, type, parent_slug, agent_abstract}`. No section content; no `abstract`. The `agent_abstract` is the primary disambiguation signal — it's terse, machine-targeted, and tells Flash what each page is *about* without paying for full content.

Flash uses the index to answer one question per pass: *which of these slugs might the transcript materially touch, and what new slugs might the transcript justify creating?*

The index is dumped in full because MVP wikis are small enough to fit. This will not scale; see Open Questions and `tradeoffs.md` for the refactor path.

### 4.2 Identifying touched pages

A page is "touched" if the transcript contains material that would plausibly add to, refine, contradict, or otherwise update what the page already says. The standard is **plausibility, not certainty** — Pro will arbitrate whether to actually write.

Flag a page as touched when:

- **Direct mention** — the entity, project, person, or concept named on the page is referenced by name or alias in the transcript.
- **Pronoun reference resolvable to the page** — "she said she'd send it" where prior context makes clear "she" is Sarah Chen.
- **Implicit reference** — "my startup" when there's exactly one `project` page that matches contextually; "my partner" → the matching `person` profile.
- **Topic match** — a substantive claim about an area covered by an existing `concept`, `topic-style note`, or `profile` sub-page. E.g., a discussion of running gear → `profile/health` if it exists.
- **Status-bucket match** — for `todo` pages, transcript contains a commitment that aligns with an existing pending todo (potential status change or refinement).

**Output for each:** `{ "slug": "<existing-slug>" }`. Slug only. No reason text, no transcript snippet. Pro will re-derive the why from the joined page content + transcript.

### 4.3 Identifying new pages

A new page is justified when the transcript introduces an entity, project, concept, or commitment that:

- Has no plausible match in the existing index, AND
- Is named with enough specificity to merit a page (a real proper noun, a clearly-articulated concept, a concrete commitment), AND
- Is referenced with enough substance that *some* claim could be written to it. A bare passing mention with no associated fact is not enough.

**Page-type assignment.** Flash assigns a `type` from the user-scope type set: `person`, `concept`, `project`, `place`, `org`, `source`, `event`, `note`, `profile`, `research`, `todo`. Pick the best fit from contextual cues. Pro may override if the transcript makes a different type clearer — that override is silent.

**Slug proposal.** Use kebab-case of the proposed title. Do not attempt collision resolution against the index (the backend handles slug-uniqueness via the two-track strategy from §4 of `todos.md`). Pro will use the proposed slug as-is unless the backend's slug generator adjusts it at commit time.

**Output for each:** `{ "proposed_slug": "...", "proposed_title": "...", "type": "..." }`. No `agent_abstract` — Pro writes that.

#### Special signal: commitment patterns → always flag `todos/todo`

If the transcript contains a commitment pattern (per `specs/fan-out-prompt.md` §4.1) — "I'll do X", "I told [person] I'd…", "remind me to…", etc. — Flash MUST flag `todos/todo` (the seeded pending-todos bucket) as a touched page.

This is load-bearing: implicit todo extraction in Pro (§4.1 of fan-out spec) is a multi-target write that requires `todos/todo` to be in the candidate set. If Flash misses it, the implicit todo is silently dropped per the §4.3 no-candidate-skip rule. Treat commitment-pattern presence as an unconditional flag, not a judgment call.

### 4.4 Recall bias

Flash is the recall bottleneck of the pipeline. Pro can cheaply skip overflagged candidates via the §4.3 routing rules (`empty-update suppression`, `premature-create-guard`) and the §4.2 noteworthiness filter. Pro **cannot** recover anything Flash misses — there is no `fetch_page` tool, no retry, no second-pass recovery for MVP.

The asymmetry:
- **False positive** (Flash flags a page Pro doesn't write to) → Pro skips it, ~modest extra preload tokens, no quality cost.
- **False negative** (Flash misses a page Pro would have written to) → silent data loss, never recovered.

**Rule: when in doubt, include.** The cost of an unnecessary inclusion is small and contained; the cost of an omission is permanent and invisible. Bias deliberately toward over-flagging.

This bias applies to *both* arrays:
- Touched: include any page where the transcript plausibly says something new about it, even on a weak signal.
- New: propose a new page when the transcript mentions a candidate entity with any substantive claim, even if it's borderline whether to track it long-term. Pro's premature-create guard will discard the ones that don't justify themselves.

### 4.5 Implicit noteworthiness gate

Flash does not emit a separate `noteworthy: true/false` field. The output itself is the gate:

- `touched_pages: []` AND `new_pages: []` → no fan-out, Pro never runs, no DB writes.
- Either array non-empty → Pro runs against the candidate set.

**Do not emit prose, explanations, or metadata about *why* nothing was found.** Empty arrays are the contract.

A transcript should produce empty arrays when:
- It's pure social pleasantries / scaffolding / greetings.
- The user's speech contains no factual content, commitments, opinions worth tracking, or new entity mentions.
- Everything mentioned is already captured in the wiki AND the transcript adds no new nuance, refinement, or contradiction.

The gate's recall bias mirrors §4.4: when in doubt whether the transcript has anything worth ingesting, return non-empty arrays and let Pro arbitrate.

### 4.6 Speaker handling

The transcript includes both `User:` and `Muse:` turns. Flash uses **both** for context — Muse's questions and prior statements provide the antecedents that resolve the user's pronouns and partial references.

But Flash's candidate emissions should be driven by the *user's* speech. If only Muse mentioned a topic and the user didn't engage, the topic is not a candidate. This pre-aligns with Pro's invariant from §4.1 of the fan-out spec: Muse's speech is not a source for claims.

---

## Output contract — hard rules

- Output is a single JSON object with exactly two keys: `touched_pages` and `new_pages`. No additional keys. No trailing commentary.
- Both keys are always present. Empty arrays are valid; missing keys are not.
- Each `touched_pages` entry has exactly one field: `slug`. The slug must match an entry in the input index verbatim.
- Each `new_pages` entry has exactly three fields: `proposed_slug`, `proposed_title`, `type`. No additional fields (no `agent_abstract`, no `parent_slug`, no `reason`).
- `type` must be one of the user-scope types: `person`, `concept`, `project`, `place`, `org`, `source`, `event`, `note`, `profile`, `research`, `todo`.
- Never invent slugs in `touched_pages` — every slug must appear in the input index. If the transcript discusses what looks like an existing page but the slug isn't in the index, treat it as a new-page candidate instead.
- Never duplicate entries within an array.
- A slug appearing in `touched_pages` must not also appear (via `proposed_slug`) in `new_pages`.

---

## Worked examples — *stub, to flesh out*

To be added: 3–4 full transcript-in / JSON-out examples covering:

- **Pure noteworthy update** — User mentions a status change for an existing person (Sarah). Output: `touched_pages: [{slug: "sarah-chen"}]`, `new_pages: []`.
- **Commitment with implicit todo** — User says "I told Alex I'd send him the paper" where Alex is in the wiki. Output: `touched_pages: [{slug: "alex-rivera"}, {slug: "todos/todo"}]`, `new_pages: []`. Demonstrates the §4.3 special signal.
- **New entity introduction** — User mentions starting a project no page exists for. Output: `touched_pages: []`, `new_pages: [{proposed_slug: "consensus", proposed_title: "Consensus", type: "project"}]`.
- **Multi-target with new + existing** — "Sarah and I are starting Consensus together." Output: `touched_pages: [{slug: "sarah-chen"}]`, `new_pages: [{proposed_slug: "consensus", ...}]`.
- **Pure scaffolding (gate negative)** — Transcript is greetings + sign-offs only. Output: `{touched_pages: [], new_pages: []}`.
- **Pronoun-resolved reference** — User refers to "she" / "my partner" / "my startup" with no proper noun. Demonstrates implicit-reference flagging.

Each example should show the input transcript snippet + relevant index excerpt + exact JSON output.

---

## Open questions

- **Index size scaling.** Full index dump breaks at ~hundreds of pages per user. Refactor path: pre-filter the index by retrieval (embedding or trigram match against transcript entities) before passing to Flash. Becomes urgent when token cost or latency grows visibly. Not an MVP concern.
- **Alias presence in the index.** The current shape (`slug, title, type, parent_slug, agent_abstract`) does not include aliases. If Flash's recall on alias-driven references (nicknames, abbreviations) is poor, the cheapest fix is to inline aliases into the `agent_abstract` text at index-render time, not to add a column to the dump.
- **Page-type assignment accuracy on borderline new entities.** A "person" who turns out to be an "org," a "concept" that's actually a "project." Pro can override silently, but if Flash's first-guess accuracy is low, the override volume signals a prompt issue worth tuning.
- **Commitment-pattern detection robustness.** §4.3 makes `todos/todo` flagging unconditional on commitment-pattern presence — this assumes Flash reliably recognizes the pattern list from the fan-out spec. Worth eval coverage.
- **Pinned-project signals.** Active projects (§19 pinning) might warrant being preloaded *unconditionally* at the system-prompt layer, not relying on Flash to flag them. Defer until pinning lands.

---

## Related decisions

- `todos.md` §6 — fan-out pipeline structure; preloaded slice = Flash's candidate set; no `fetch_page` fallback
- `specs/fan-out-prompt.md` §4.1 — commitment patterns Flash must recognize
- `specs/fan-out-prompt.md` §4.3 — Pro routing rules that Flash's candidate emission feeds
- `tradeoffs.md` — Flash candidate retrieval, full index dump for MVP, recall bias
- `notes/ingestion-pipeline.md` — full pipeline context for this prompt's role
- `specs/agents-and-scope.md` — this retrieval prompt covers the user-scope fan-out only; a separate sibling prompt (TBD) runs for the agent-scope pass
