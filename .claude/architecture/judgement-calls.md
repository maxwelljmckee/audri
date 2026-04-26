# Judgement Calls

Log of decisions made without explicit user confirmation during the autonomous spec-completion phase (final push to close MVP design before code phase). Each entry: what I decided, what alternatives existed, why I picked this, and what would trigger reconsideration.

Review these before production coding starts — most are reasonable defaults but at least a few may not match the user's intuition.

Created: 2026-04-25.

---

## §10 Onboarding

### Onboarding interview "good enough" thresholds — REVISED 2026-04-26
- **Decided (current):** Target ~10 min average. Wraps when ≥1 of: 4+ of **7 askable** profile areas covered substantively (Values + Psychology emergent-only, don't count); user explicitly signals done; **15-min** soft cap reached.
- **Revision history:**
  - Initial proposal (mine): 5/8, 25-min cap.
  - 2026-04-26: Life-History added → 5/9, 25-min cap.
  - 2026-04-26 (user feedback): Values + Psychology made emergent-only (never explicitly asked); target 10 min average; 15-min soft cap; threshold 4/7.
- **Why current:** Values + Psychology answers feel stilted when asked directly; far richer signal emerges from how the user talks about other areas. Conversational interview shouldn't push toward longer calls — 10 min is a healthy first-impression length.
- **Reconsider if:** Onboarding completion rate is too low OR profile pages come out too thin.

### Onboarding interview format — REVISED 2026-04-26
- **Decided (current):** Structured-but-conversational. Standard opening (self-intro + "What brings you to Muse?"). Topics scoped to 7 askable profile areas (Values + Psychology emergent-only). Slightly proactive capability advertisement tied to stated needs (no upfront feature menu). Order + depth + transitions adapt to user.
- **Revisions on 2026-04-26 (user feedback):** added explicit self-intro template; added opener question; flagged Values + Psychology as never-explicitly-asked; shifted capability advertisement from "intentionally minimal" to "slightly proactive but balanced."
- **Why:** Voice-first should feel conversational, not surveyed; opener naturally surfaces multiple profile areas at once; emergent-only treatment for Values + Psychology produces richer signal than direct asks; capability balance lets users learn what's possible without feeling sold to.
- **Reconsider if:** Profile pages come out too thin OR feel too interrogative OR users leave onboarding without understanding what Muse can do.

### Onboarding seed: 5 agent-scope pages instead of 4
- **Decided:** Default Assistant agent's seed subtree is 5 pages (root + observations + recurring-themes + preferences-noted + open-questions).
- **Alternatives:** Just root + auto-create children when needed; richer seed (e.g., per-life-domain observation pages).
- **Why:** Pre-seeding gives the agent-scope ingestion pass natural landing pages from call 1 (vs. needing to bootstrap structure on first observation).
- **Reconsider if:** The seed structure feels presumptuous OR if observations naturally cluster around different categories than the seed predicted.

### Onboarding state tracked in-call only, not persisted
- **Decided:** No `onboarding_state` table or column. State of onboarding is implicit in profile-content thickness.
- **Alternatives:** Explicit per-area completion flags / state machine.
- **Why:** Simpler; the profile pages are the source of truth anyway.
- **Reconsider if:** Need to surface onboarding-progress UI between sessions (would warrant explicit tracking).

### `user_settings` as a dedicated table vs. jsonb on `auth.users`
- **Decided:** Dedicated `user_settings` table.
- **Alternatives:** Inline jsonb on auth.users (simpler) — but auth.users is Supabase-managed.
- **Why:** Keeps our domain data separate from Supabase Auth's table; queryable as a normal Postgres row.
- **Reconsider if:** Settings stays minimal long-term — could collapse to jsonb on a different existing table.

---

## §3 Data model

### `frontmatter` jsonb scope
- **Decided:** Loosely-structured per-type fields (aliases, tags-denormalized, todo-specific assignee/priority/due_at, event_date for events, etc.).
- **Alternatives:** Push everything into normalized columns; or inline more into top-level columns.
- **Why:** Schema flexibility for type-specific quirks without a column proliferation; UI can read/write directly.
- **Reconsider if:** Specific fields become hot query paths warranting promotion to columns.

### Alias indexing via GIN on `frontmatter`
- **Decided:** GIN index covers `aliases` array lookups via the jsonb `frontmatter` column.
- **Alternatives:** Dedicated `aliases(page_id, alias)` table with trigram or btree; generated column.
- **Why:** Avoids extra table at MVP; GIN handles common lookup patterns.
- **Reconsider if:** Voice disambiguation latency is bad (then promote to dedicated table).

### History retention: full snapshots, indefinite
- **Decided:** Full content snapshots in `wiki_section_history`, no GC, no diff compression at MVP.
- **Alternatives:** Diff-based compression; periodic GC after N months.
- **Why:** MVP user count makes storage non-issue; full snapshots are simpler to reason about.
- **Reconsider if:** Per-user `wiki_section_history` row count grows visibly.

### Tombstone retention: permanent
- **Decided:** Tombstoned rows stay forever; `tombstoned_at` timestamp marks them.
- **Alternatives:** GC after N days.
- **Why:** Lets users undo months-old tombstones; storage cheap at MVP scale.
- **Reconsider if:** Storage growth or query degradation.

### Conflict resolution: server-wins for AI writes; LWW for user edits
- **Decided:** RxDB's standard last-write-wins for user edits; AI writes from ingestion can clobber concurrent user edits if they reach server first.
- **Alternatives:** Section-level lock window after user edit; merge-based resolution.
- **Why:** Simple to implement; section history preserves both versions for audit recovery.
- **Reconsider if:** Users frequently see their edits clobbered by ingestion (then add user-edit lock).

### Offline behavior: optimistic reads + queued writes; no offline call mode
- **Decided:** RxDB cached reads work disconnected; writes queue + replay on reconnect; calls require connectivity.
- **Alternatives:** Online-only at MVP (simpler); fuller offline support including offline note-mode.
- **Why:** Offline reads/writes essentially come for free with RxDB; offline calls are intractable (Gemini Live needs network).
- **Reconsider if:** Specific offline workflows become critical.

### Initial hydration: paginated by `updated_at DESC` + realtime sync after
- **Decided:** ~100 rows at a time, recently-touched first.
- **Alternatives:** Full dump (simpler but slow); priority-based (profile + recent first, rest in background).
- **Why:** Recent-first surfaces useful content fast; works at MVP wiki sizes; refinement deferable.
- **Reconsider if:** Hydration time hurts first-load UX at scale.

---

## §3 RLS policies

### RLS draft per-table
- **Decided:** Substantive draft (see `todos.md` §3 RLS policy set) covering all MVP tables.
- **Alternatives:** Skeletal draft requiring code-time refinement; security-first approach with stricter defaults.
- **Why:** Enough specificity to write migrations against; cross-agent leakage tests enumerated separately.
- **Reconsider if:** Security audit reveals gaps (likely; this is a first pass).

### Persona prompt redaction via column-level grants / restricted view
- **Decided:** `persona_prompt` + `user_prompt_notes` excluded from client-facing `agents` view.
- **Alternatives:** RLS-only (less defense-in-depth); separate sensitive-only table.
- **Why:** Column-level isolation is the cleanest pattern in Postgres.
- **Reconsider if:** RLS + view combo proves brittle in practice.

---

## §17b Usage events

### `event_kind` enum (MVP set) — REVISED 2026-04-26
- **Decided (current):** `'call_live'`, `'ingestion_prefilter'`, `'ingestion'`, `'agent_scope_ingestion'`, `'plugin_research'`, plus `'tool_search_wiki'` / `'tool_fetch_page'` for analytics.
- **Revision:** initially proposed `'ingestion_flash'` and `'ingestion_pro'`; user pushed back on coupling DB column values to inference-provider naming (Flash / Pro are Gemini terms). Renamed to `'ingestion_prefilter'` (candidate-retrieval pass) and `'ingestion'` (main fan-out pass) — provider-agnostic.
- **Alternatives:** Coarser set (`'call'` / `'ingestion'` / `'task'`); finer set (per-tool / per-prompt-version).
- **Why current:** Enough granularity for per-service cost attribution; not so fine that the rate table explodes; provider-agnostic so swapping models doesn't require migration.
- **Reconsider if:** Cost analytics need finer breakdown.

### Per-model rate table maintained in code, not DB
- **Decided:** Code constant updated on Gemini pricing changes.
- **Alternatives:** DB rate table; external pricing service.
- **Why:** Pricing changes infrequently; a code constant is the lowest-friction option; deploys are fast.
- **Reconsider if:** Pricing changes accelerate or admin needs to override per-tenant.

### No `usage_daily` rollup table at MVP
- **Decided:** Raw events only; nightly rollup deferred to V1+.
- **Alternatives:** Build rollup from day one for dashboard performance.
- **Why:** Ad-hoc SQL works at MVP volume; rollup is straightforward to add when query times bite.
- **Reconsider if:** Dashboard queries become slow.

---

## §11 Background loop refinements (already substantively confirmed in chunk reviews; flagged here for completeness)

These were confirmed in user reviews but worth re-flagging as the user explicitly accepted my leans rather than producing their own:

- Atomic enqueue + 30s CRON scanner (vs. CRON-only or pg_notify) — confirmed
- `agent_tasks` shared queue across users (no per-user fairness at MVP) — confirmed
- Transactional commit idempotency (vs. checkpointing) — confirmed
- Separate Render worker service (vs. embedded) — confirmed
- Conservative retry posture (1–2 attempts) — confirmed
- All kinds default `reingestsIntoWiki: false` at MVP — confirmed (correction from initial proposal of `research: true`)

---

## §8 Call-agent (already confirmed in chunk reviews; flagged here for completeness)

- Conservative preload budget (10–15k slice / 13–15k total system prompt) — user opted to start lower
- No mid-call task initiation in `generic` calls; trial-artifact exception originally for onboarding then bumped to V1+
- Gemini Live built-in Google grounding for MVP (vs. custom abstraction) — confirmed
- Two-phase call-end with confirmation gating only agent-executed actions — confirmed; **2026-04-26 amendment**: confirmation can happen mid-call OR in recap. Mid-call user "yes" to a Muse-advertised capability counts as confirmed; recap doesn't need to re-surface those items. May still mention briefly for transparency if list is short or user asks. Users can drop mid-call confirmations in any later turn.
- Transcript-only audio retention at MVP — confirmed

---

## Architecture.md / Features.md sync

### Architecture.md rewritten from scratch rather than edited in place
- **Decided:** Replaced architecture.md wholesale with a current-state document.
- **Alternatives:** Edit existing sections one-by-one preserving structure.
- **Why:** Drift was substantial enough that targeted edits would have left scaffolding from old design choices that no longer applied. Fresh write is cleaner and matches the locked decisions point-for-point.
- **Reconsider if:** Specific historical structure was load-bearing (didn't appear to be).

### Features.md restructured around MVP / V1+ tags
- **Decided:** Each feature explicitly tagged for MVP scope or V1+.
- **Alternatives:** Keep features.md as a horizon catalog with no inline scope tags (relying on backlog.md for V1+ tracking).
- **Why:** Inline tags make features.md self-contained — readable without cross-referencing backlog.
- **Reconsider if:** Inline tags drift from backlog.md (need to maintain in sync).

---

## §10 Onboarding edits

### Trial artifacts bumped to backlog (P0)
- **User-instructed:** explicit user direction.
- Listed here for traceability — moved to backlog.md as P0 V1 entry.

### Onboarding scaffolding cache (separate from generic call scaffolding)
- **Decided:** Distinct Gemini explicit cache entry; same lifecycle management.
- **Alternatives:** Single scaffolding with mode flag.
- **Why:** Onboarding's instructions diverge enough from generic that mixing them in one prompt confuses both.
- **Reconsider if:** Cache management overhead becomes meaningful (unlikely with two caches).

---

## How to use this log

1. Skim before code phase begins.
2. For any entry that doesn't match your intuition, push back — most of these are reasonable defaults, not load-bearing convictions.
3. Resolved entries can be deleted from this log (or moved to `tradeoffs.md` if they were genuine alternatives-weighed decisions).
4. As more autonomous decisions get made (during code-phase implementation), add to this log so they don't get lost.
