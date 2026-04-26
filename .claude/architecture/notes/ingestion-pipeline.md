# Ingestion Pipeline — Server-side Transcript → KG

## Purpose

The ingestion pipeline turns a committed call transcript into structured updates to the user's knowledge graph. It is the central mechanism that keeps the wiki compounding — every call makes the KG denser and more useful for the next one.

This doc captures both the *conceptual* breakdown of the pipeline (granular, 8 stages) and the *MVP implementation* (2 LLM calls + mechanical DB writes), plus the tradeoffs involved and refactor paths if the simple version hits limits.

**Scope note:** Everything below describes the **user-scope fan-out** — writes to the user's shared wiki. Agent-scope writes (each agent persona's private observational notes) run in a separate, lightweight Flash-driven pass documented in `specs/agents-and-scope.md` (and a forthcoming `specs/agent-scope-ingestion.md`). Pro's user-scope-only invariant is preserved; the two passes never commingle.

---

## Input / Output boundaries

**Input:** An immutable `call_transcripts` row. The transcript is stored before the pipeline runs, so the pipeline reads from Postgres, not over the wire.

**Output:** A transactional set of DB writes:

- `wiki_pages` inserts (new pages) and metadata updates (title / `agent_abstract` / `abstract` regeneration)
- `wiki_sections` inserts (new sections), updates (changed content), and tombstones (removed sections)
- `wiki_section_history` rows (one per new version — create or content update)
- `wiki_section_transcripts` rows (one per transcript snippet grounding each section write)
- One `wiki_log` row summarizing the ingest event (also records page-level creation / tombstone events)

**Guarantee:** the whole thing runs in a single transaction. The transcript's effects land atomically, or none of them do.

---

## The 8-stage conceptual breakdown

The pipeline is easiest to reason about as 8 discrete stages, grouped into three phases that map to the actual implementation. Phase 1 is a cheap retrieval pass; phase 2 is the main parsing call; phase 3 is the deterministic backend commit. Several stages collapse in practice (see next section), but keeping the conceptual model distinct from the implementation is useful for debugging and for evaluating *where* to split things apart later.

### Phase 1 — Retrieval (Flash)

1. **Candidate retrieval** — given the transcript + the wiki index, enumerate the candidate *touched pages* (existing pages likely to need updates) and the candidate *new pages* (entities introduced by the transcript that don't yet exist in the index). This stage implicitly gates transcript-level noteworthiness: if the candidate set is empty, the transcript has no signal to ingest and the pipeline short-circuits.

### Phase 2 — Parsing (Pro)

2. **Claim extraction** — produce discrete factual claims from the transcript (e.g., "Sarah lives in Boulder"; "the user wants to learn guitar").
3. **Per-claim noteworthiness filter** — drop noise claims (filler, social nothings, low-signal digressions). The surviving claims are the ones that get written. This is where noteworthiness judgment actually happens — at claim granularity, not transcript granularity. Reflected in the `skipped` array of Pro's output.
4. **Routing + entity resolution** — for each retained claim, match it to a candidate page from Phase 1 (update) or a candidate new entity (create). Entity disambiguation ("Sarah" → `sarah-chen`) happens here, constrained to the candidate set. A single claim may touch multiple candidate pages (e.g., a claim about Sarah's new job touches both her `person` page and the user's `profile/work` page).
5. **Contradiction detection** — for each page being updated, identify contradictions against existing section content. If a contradiction arises, fan-out must move the superseded claim out of its current section and into a `Timeline` section (creating that section if it doesn't already exist).
6. **Section write set + abstract regeneration** — emit the desired final list of sections per touched page (keep-as-is by id, update content by id, create new by title, tombstone by absence). Always regenerate `agent_abstract` and (if applicable) `abstract` for every touched or created page.
7. **Source attribution** — per section write, emit the transcript passages that grounded it as `{ turn_id, text }` snippets.

### Phase 3 — Commit (backend)

8. **Transactional DB commit** — write `wiki_pages` rows (insert or metadata update), `wiki_sections` rows (insert / update / tombstone), `wiki_section_history` snapshots, `wiki_section_transcripts` attribution rows, and one `wiki_log` entry summarizing the ingest. All atomic.

---

## MVP implementation — collapsed to 2 LLM calls + mechanical stages

In practice, the 8 stages collapse into this:

```
Transcript
    │
    ▼
[Flash] Candidate retrieval     — stage 1
                                  Output: touched_pages ({slug}) + new_pages ({proposed_slug, proposed_title, type})
    │
    ▼
[backend] Preload assembly      — fetch full content for every slug in touched_pages
    │
    ▼
[Pro]   Main fan-out            — stages 2, 3, 4, 5, 6, 7
                                  Output: creates[], updates[], skipped[]
                                  Each write carries: agent_abstract, abstract,
                                  section keep/update/create ops, snippets
    │
    ▼
[SQL]   Transactional commit    — stage 8 + all DB writes
                                  wiki_pages + wiki_sections
                                  + wiki_section_history
                                  + wiki_section_transcripts + wiki_log
                                  Atomic.
```

**Why this shape:**

- **Flash does candidate retrieval, not just noteworthiness.** It operates only on the transcript + wiki index (no full page content). Its job is to identify which existing pages the transcript likely touches and which new pages it proposes creating. The noteworthy/not-noteworthy decision falls out for free — empty candidate set = nothing to do. Runs on Flash.
- **Main fan-out is everything else in one pass.** Stages 2–7 happen in a single Pro call that receives the transcript + the full joined content of Flash's candidate pages + the new-page plan. This call does the real semantic work: claim extraction, per-claim noise filtering, routing + entity resolution (constrained to candidates), contradiction detection, Timeline-section placement, section-level content writes, abstract regeneration, source attribution.
- **Mechanical stages live in the backend.** The LLM emits semantic content only (titles, slugs, section ids, markdown, abstracts, source snippets with turn IDs). The backend wraps every write with `user_id`, scope, UUIDs, timestamps, resolved `parent_page_id`, canonical slug generation, section sort_order assignment, tombstoning of absent sections, and the transactional commit.

**MVP scope constraint — Pro is bounded by Flash's candidate set.** Pro does *not* have a `fetch_page` tool and cannot reach beyond the pages Flash preloaded. If Flash misses a page the transcript actually touches, the claim is silently dropped (or, at best, routed to an imperfect candidate). This is a deliberate MVP simplification: tool use + structured JSON output is awkward to make reliable, and a two-pass "fetch then re-invoke" design doubles Pro calls. We accept the recall risk; the refactors section below lists the ways out.

---

## LLM I/O contracts

### Candidate retrieval (Flash)

See `specs/flash-retrieval-prompt.md` for the authoritative contract. Summary:

**Input:**

- Transcript (turn-tagged, with explicit `User:` / `Muse:` speaker labels)
- Wiki index: `(slug, title, type, parent_slug, agent_abstract)` for every active page under the user's `user_id + scope='user'`. No section content. No aliases column — aliases, if needed for recall, are inlined into `agent_abstract` at render time.
- (KG candidate-retrieval system instruction — explicitly cached)

**Output:**

```json
{
  "touched_pages": [
    { "slug": "sarah-chen" }
  ],
  "new_pages": [
    { "proposed_slug": "consensus", "proposed_title": "Consensus", "type": "project" }
  ]
}
```

Slug only for touched (Pro re-derives the why from the joined page + transcript). For new pages: slug + title + type; no seed `agent_abstract` (Pro writes that with full context).

An empty `touched_pages` AND empty `new_pages` means the transcript is not noteworthy; the pipeline short-circuits without invoking Pro.

### Main fan-out (Pro)

**Input:**

- Transcript (turn-tagged, same as Flash)
- For every slug in `touched_pages`: the full joined page as a JSON object
  ```json
  {
    "slug": "sarah-chen",
    "title": "Sarah Chen",
    "type": "person",
    "agent_abstract": "Software engineer working on distributed systems.",
    "abstract": "Sarah is a software engineer at Consensus, a distributed-systems startup. She's been in the field since 2019.",
    "sections": [
      { "id": "7a3f-...", "title": "Timeline",   "content": "- **Current** — ..." },
      { "id": "c9d1-...", "title": "Background", "content": "..." }
    ]
  }
  ```
- The `new_pages` plan from Flash
- (KG parsing system instruction — explicitly cached, large static preamble)

**Output:**

```json
{
  "creates": [
    {
      "title": "Consensus",
      "type": "project",
      "parent_slug": null,
      "agent_abstract": "Max's distributed-consensus startup.",
      "abstract": "Consensus is a new project Max is building around distributed consensus algorithms...",
      "sections": [
        {
          "title": "Background",
          "content": "...markdown...",
          "snippets": [
            { "turn_id": "T42", "text": "I've been thinking a lot about consensus..." }
          ]
        }
      ]
    }
  ],
  "updates": [
    {
      "slug": "sarah-chen",
      "agent_abstract": "Software engineer, recently moved to Portland.",
      "abstract": "Sarah is a software engineer...",
      "sections": [
        { "id": "7a3f-...",
          "content": "- **Current** — Sarah lives in Portland (moved April 2026).\n- **Past** — Lived in Boulder 2020–2026.",
          "snippets": [
            { "turn_id": "T73", "text": "Sarah mentioned she moved to Portland last month" }
          ]
        },
        { "id": "c9d1-..." }
      ]
    }
  ],
  "skipped": [
    { "slug": "profile-goals", "reason": "no substantive claim on re-read" }
  ]
}
```

**Per-update section contract:**

- Section entries referenced by `id` only → keep as-is (no content change, no new source rows).
- Section entries referenced by `id` with `content` (and optionally `title`) → update content; insert a new `wiki_section_history` row; attach any provided `snippets` as new `wiki_section_transcripts` rows.
- Section entries with no `id` (just `title` + `content`) → create new `wiki_sections` row; snippets attach to the newly-created section.
- Existing sections that are **absent from the list** → tombstone.
- List order → new `sort_order` for the section set.

The LLM emits only turn-level snippet attribution. The backend fills in `transcript_id` from pipeline context (single transcript being processed) and writes one `wiki_section_transcripts` row per snippet per section.

`agent_abstract` is required on every `create` and `update`. `abstract` is optional (nullable on the page).

---

## Backend layer — what the LLM never touches

The LLM works in slugs, section ids, titles, and markdown. The backend does everything infrastructural:

- **UUIDs** — `wiki_pages.id`, `wiki_sections.id` are DB-generated on insert.
- **Timestamps** — `created_at`, `updated_at`, `cited_at` are stamped with `now()` at write time.
- **`user_id`, `scope`** — stamped from the invocation context, never trusted from LLM output.
- **`parent_page_id`** — resolved from `parent_slug` at write time by looking up the parent by slug under the same `user_id + scope`.
- **Canonical slug generation for new pages** — title + parent + existing pages → final slug, via the walk-up rule (for standard types) or hash-suffix (for high-churn types like `todo`).
- **Slug → id resolution for updates** — `slug + user_id + scope → wiki_pages.id` lookup.
- **Section sort_order assignment** — the list position in the LLM's output is translated into `sort_order` values on insert/update.
- **Tombstoning absent sections** — sections currently in DB for the page but missing from the LLM's output list get `tombstoned_at = now()`.

### Write pattern per operation (all within one transaction)

**Create (new page):**

```sql
INSERT INTO wiki_pages (id, user_id, scope, type, slug, parent_page_id,
                       title, agent_abstract, abstract, ...)
-- for each section in the creates[].sections list (in order):
INSERT INTO wiki_sections (id, page_id, title, content, sort_order, ...)
INSERT INTO wiki_section_history (section_id, content, edited_by='ai', ...)
-- for each snippet under that section:
INSERT INTO wiki_section_transcripts (section_id, transcript_id, turn_id, snippet, cited_at)
```

**Update (existing page):**

```sql
UPDATE wiki_pages
  SET agent_abstract=?, abstract=?, updated_at=now()
  WHERE id=?
-- for each section entry in updates[].sections (in order):
--   Case A: id present, no content        → leave untouched except sort_order reassignment
--   Case B: id present, content provided  →
    UPDATE wiki_sections SET content=?, title=COALESCE(?, title),
                             sort_order=?, updated_at=now() WHERE id=?
    INSERT INTO wiki_section_history (section_id, content, edited_by='ai', ...)
    INSERT INTO wiki_section_transcripts (...)  -- for each snippet under this section
--   Case C: no id (create)                 →
    INSERT INTO wiki_sections (id, page_id, title, content, sort_order, ...)
    INSERT INTO wiki_section_history (section_id, content, edited_by='ai', ...)
    INSERT INTO wiki_section_transcripts (...)  -- for each snippet under this section

-- for each section currently in DB for this page but absent from the LLM's list:
UPDATE wiki_sections SET tombstoned_at=now() WHERE id=?
```

Other source-junction tables (`wiki_section_urls`, `wiki_section_ancestors`, `wiki_section_uploads`) are populated by *other* pipelines — research tasks, upload ingestion. They are not touched by transcript fan-out.

**End of transaction:**

```sql
INSERT INTO wiki_log (kind='ingest', ref=transcript_id, summary=..., created_at=now())
```

### `wiki_section_history` convention

Every version of a section — including the initial creation — gets a row in `wiki_section_history`. The row stores the full `content` snapshot at that version.

- `wiki_sections.content` always mirrors the latest history row.
- `edited_by` distinguishes: `'ai'` (fan-out), `'user'` (UI edit), `'lint'` (healthcheck pass), `'task'` (background task output).
- **Section rollback** = copy an old history row's `content` back into `wiki_sections`, write a new history row recording the rollback.
- **Page rollback** (restoring "page as of time T") = join all sections of the page against their history, take the latest version-before-T per section. More complex than a single-row restore; acceptable tradeoff for section-level granularity.

This pattern trades slight storage redundancy (latest version duplicated in `wiki_sections`) for uniform query simplicity. Page-level creation / tombstone events live in `wiki_log` rather than a dedicated page-history table.

---

## Tradeoffs of the collapsed design

### What we gain

- **Low call count per transcript.** Two LLM calls total — cost-efficient and low-latency.
- **Shared context between stages.** The main call holds transcript + relevant pages in one prompt, so claim extraction, routing, contradiction detection, and content rewriting all reason from the same full picture. Splitting these apart risks losing the cross-stage context that lets the LLM make coherent decisions.
- **Simple failure modes.** Two calls, one transaction. If anything fails, we retry the pipeline from the top; the transcript is immutable, so idempotency is easy.
- **Heavy prompt caching wins.** The main call's large static KG parsing system instruction is a perfect fit for Gemini explicit caching. Almost all the per-call cost is the variable input (transcript + page content).

### What we give up

- **Recall bounded by Flash.** Pro cannot write to any page Flash did not flag. If Flash misses a touched page, the claim is silently dropped. MVP tradeoff — see refactor paths.
- **Stage-level retry granularity.** If the main call produces malformed output on one write but good output on the others, we can't cleanly retry just that one. We retry the whole main call. Acceptable for normal transcripts; potentially wasteful for long or fact-dense ones.
- **Stage-level model tiering.** Ideally each stage runs on the cheapest model that can handle it. The collapsed version uses Pro for all of stages 2–7, even though parts of that (classification, summarization) could run on Flash. Prompt caching compensates heavily.
- **Observability of intermediate reasoning.** With one big call, internal reasoning (what got filtered, what got extracted, which claims were contradictions) is opaque unless we ask the LLM to emit it explicitly. Split stages make each decision naturally observable via its output.
- **Stage-level evals.** "Given X, does per-claim noteworthiness return Y" is easier to eval than "given X, does the whole pipeline produce Y writes." Coarser evals cover the collapsed design.

---

## Possible refactors — if / when we hit limits

### If the main Pro call hits context limits

The main call sees transcript + full joined content of every touched page. For users with very large pages or very long calls, options include:

- Chunk the transcript into overlapping windows; run the main call per chunk; merge write-plans in the backend.
- Per-page narrowing: load only a subset of sections (e.g., Timeline + any alias-hit sections) rather than the full joined page. Requires a second-pass heuristic for which sections to include.

### If Pro quality is insufficient for contradiction detection

Split stage 5 (contradiction detection) out into its own call, one per touched page. Each call has narrow scope (one page's joined sections + the claims earmarked for it) and can run on Pro with a targeted prompt. Costs go up, but quality rises and per-page evals become possible.

### If Pro cost is unsustainable at scale

Peel off cheap stages to Flash:

- **Stage 3 (per-claim noteworthiness)** is pure classification. Could split into a Flash pre-pass over extracted claims; Pro only sees signal. Likely not worth the complexity unless claim-level noise filtering becomes a measurable cost driver.
- **Stage 6 (summary regeneration)** is summarization — Flash-appropriate. Split it out and run per-page on Flash after the main Pro call. Biggest-leverage candidate.
- **Stage 2 (claim extraction)** is borderline — Flash can do rough extraction but may miss implicit claims. Empirical question.

### If Flash recall is insufficient (the main MVP risk)

Flash is the sole authority on which pages Pro can touch. If it misses a page, the claim is dropped. Mitigations, in rising order of complexity:

- **Post-hoc recovery pass.** After the main call, run a Flash "did we miss anything?" check against the transcript + the pages *not* preloaded. Surface misses for a follow-up fan-out on just those. Cheap; preserves deterministic call count per transcript.
- **Two-pass structured fetch.** Let Pro emit `pages_i_also_need: [...]` alongside its JSON output. Backend re-invokes Pro with those pages preloaded. Deterministic call count (≤2 Pro invocations), no tool-use complexity.
- **`fetch_page` tool.** Give Pro an actual tool to pull any indexed page on demand. Most flexible, but tool use + structured output together is flakier; requires careful prompt + output-schema engineering.
- **Embedding-based candidate retrieval alongside Flash.** Use pgvector similarity between the transcript and page embeddings to union with Flash's candidates. Cheap at runtime once the embedding pipeline is in place; requires the embedding infrastructure.

### If pre-filter accuracy is a problem in the other direction (false positives)

Flash flags pages the transcript doesn't actually touch. Pro gets extra content in its prompt that it correctly skips — wasted tokens but not wrong writes. Lower-priority failure mode; tighten Flash prompt before doing anything structural.

### If stage-level observability is needed without splitting

Instruct the main call to emit intermediate reasoning in its output — e.g., a `reasoning` field per write, or a `filtered_turn_ids: [..]` field. Cheap; doesn't require architectural change.

### If we need per-stage evals

Split out just the stages we're trying to eval. If contradiction detection is flaky, pull stage 5 out into its own call and build an eval harness specifically for it. The rest of the pipeline stays collapsed.

---

## Open sub-designs (not yet finalized)

- **KG parsing prompt (main fan-out system instruction).** The large, cached, static preamble that defines Pro's behavior for stages 2–7. Deserves its own SPEC doc.
- **Candidate-retrieval prompt.** The Flash system instruction for stage 1. Deserves its own SPEC doc.
- **Partial-failure handling.** What happens if a slug in `touched_pages` can't be resolved (tombstoned between pre-filter and main call)? What if a `create` fails a DB constraint (e.g., title collision under the same parent that the pre-filter didn't anticipate)? Needs a recovery policy.
- **Idempotency for reprocessing.** If we ever need to reprocess a transcript (e.g., because the KG parsing prompt changed meaningfully), how do we avoid duplicate history rows and duplicate source rows? Candidate: a `transcript_version` or `pipeline_version` tag on each write.
- **Concurrency.** If multiple transcripts from the same user are ingested concurrently, how do we avoid write conflicts on the same page? Candidate: per-user ingest serialization via Graphile Worker queue constraints.

---

## Related docs

- `todos.md` §6 — pipeline sub-decisions tracked as TODOs
- `todos.md` §4 — the Timeline contradiction-handling heuristic that stage 5 implements
- `todos.md` §5 — the grounding principle that stage 8 implements
- `specs/fan-out-prompt.md` — authoritative system-instruction rules for Pro
- `specs/flash-retrieval-prompt.md` — authoritative system-instruction rules for Flash
- `specs/agents-and-scope.md` — this pipeline is the **user-scope** fan-out. Agent-scope writes happen in a separate, lightweight Flash-driven pass; Pro's user-scope-only invariant is preserved.
- `architecture.md` §Server-side transcript processing — the earlier rough-shape version (needs a sync pass per `todos.md` §23)
