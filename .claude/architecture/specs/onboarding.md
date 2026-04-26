# SPEC — Onboarding interview + wiki seeding protocol

Status: **draft** — design rules locked across all chunks. Prompt-text drafting + worked examples + evals remain.

The onboarding interview is the user's first interaction with Muse. It's a Gemini Live call (`call_type='onboarding'`) with a specialized scaffolding that guides Muse through a structured-but-conversational flow to fill out the user's profile pages. The flow runs after a server-side seed transaction populates baseline wiki structure.

This SPEC covers two things:
1. **Wiki seeding protocol** — what gets created in the DB at signup (pre-interview state)
2. **Interview design** — how Muse navigates the conversation, tracks progress, and decides when to wrap up

---

## Wiki seeding protocol

Runs once at signup, before the user enters the onboarding interview. Single Postgres transaction; failure means signup fails (no partial seeding).

### Tables touched

```
auth.users                      (created via Supabase Auth, not by us)
agents                          (1 row — default Assistant)
wiki_pages                      (~14 rows — see breakdown)
wiki_sections                   (0 rows — pages start empty; interview fills them)
user_settings (or similar)      (1 row for plugin enablement, see below)
```

### `agents` row

One row per user, the default Assistant:

```
id: <generated uuid>
user_id: <auth.users.id>
slug: 'assistant'
name: 'Assistant'
voice: <Gemini Live default voice id; configurable later>
persona_prompt: <stock Assistant persona; static text in seed module>
user_prompt_notes: NULL
root_page_id: <set after wiki_pages seeding; backfilled in same transaction>
is_default: TRUE
created_at: now()
tombstoned_at: NULL
```

The default Assistant persona prompt establishes Muse's baseline voice — friendly, warm, concise, curious, honest. Custom persona prompts arrive V1+ via custom-agent UX.

### `wiki_pages` seed

14 rows total per user. All `tombstoned_at: NULL`.

**Agent-scope (4 pages):**
- `assistant` (root) — `scope='agent'`, `agent_id=<assistant_id>`, `parent_page_id=NULL`, `type='agent'`, `agent_abstract='Assistant root.'`, `abstract=NULL`
- `assistant/observations` — `scope='agent'`, child of root, `type='agent'`
- `assistant/recurring-themes` — `scope='agent'`, child of root, `type='agent'`
- `assistant/preferences-noted` — `scope='agent'`, child of root, `type='agent'`
- `assistant/open-questions` — `scope='agent'`, child of root, `type='agent'`

(That's 5 agent-scope pages; updating count.)

**User-scope profile (10 pages):**
- `profile` (root) — `scope='user'`, `parent_page_id=NULL`, `type='profile'`
- `profile/goals` — child of root, `type='profile'`
- `profile/values` — child of root, `type='profile'`
- `profile/life-history` — child of root, `type='profile'`
- `profile/health` — child of root, `type='profile'`
- `profile/work` — child of root, `type='profile'`
- `profile/interests` — child of root, `type='profile'`
- `profile/relationships` — child of root, `type='profile'`
- `profile/preferences` — child of root, `type='profile'`
- `profile/psychology` — child of root, `type='profile'`

**User-scope todos (5 pages):**
- `todos` (root) — `scope='user'`, `parent_page_id=NULL`, `type='todo'`
- `todos/todo` — child of root, `type='todo'`
- `todos/in-progress` — child of root, `type='todo'`
- `todos/done` — child of root, `type='todo'`
- `todos/archived` — child of root, `type='todo'`

Total seeded `wiki_pages`: 5 (agent) + 10 (profile) + 5 (todo) = **20 rows**.

All seeded pages have:
- `agent_abstract` populated with a terse stock string per page (see template below)
- `abstract` = NULL
- `frontmatter` = `{}`
- No `wiki_sections` rows yet — pages are empty; onboarding fills profile sections; agent-scope pages fill via agent-scope ingestion as calls accumulate; todo buckets stay empty containers.

### `agent_abstract` stock templates

Profile root: *"The user's profile — who they are, what matters to them."*
Profile children: *"The user's {goals|values|life-history|health|work|interests|relationships|preferences|psychology}."*
Agent root: *"Private notes about the user, kept by the Assistant."*
Agent children: *"{Observations|Recurring themes|Preferences noted|Open questions} kept by the Assistant."*
Todos root: *"The user's todos."*
Todo buckets: *"Todos that are {pending|in-progress|done|archived}."*

These are placeholder abstracts — terse, machine-readable, sufficient for index inclusion. They stay in place until ingestion writes content that warrants regeneration.

### Plugin enablement seed

A `user_settings` row (or equivalent — TBD whether dedicated table or jsonb on `auth.users`) carrying:

```
{
  enabled_plugins: ['research'],
  // ... other settings
}
```

`research` is pre-enabled so the user can request research from any post-onboarding call without explicit plugin-installation. Other plugins (V1+) require explicit enablement.

### Seed transaction semantics

All inserts atomic in one transaction. If any insert fails, signup fails — never leave a user with a half-seeded wiki. Idempotency: server checks for existing seed before running (lookup `wiki_pages WHERE user_id=? AND slug='profile' AND scope='user'`); if seed already ran, skip. Lets us safely retry signup.

---

## Onboarding interview design

### Flow

1. User signs up (Supabase Auth)
2. Server runs seed transaction (above)
3. Client transitions to onboarding screen — automatically initiates a call with `call_type='onboarding'`
4. Interview proceeds (described below)
5. User explicitly ends or hits "good enough" heuristic
6. Interview wraps up; user lands on home screen
7. Standard ingestion runs against the transcript (per §6 ingestion pipeline) — fills profile pages with extracted claims

### Interaction shape

Muse runs a **structured-but-conversational** interview. Not a rigid scripted Q&A; not freeform chat. Topics are scoped (a subset of the profile sub-areas) but the order, depth, and conversational style adapt to the user.

Onboarding scaffolding instructs Muse to:
- Open with the standard self-introduction (see below) followed by the opener question
- Follow the user's lead from there — pick transitions based on what they share
- Ask follow-up questions when answers are vague
- Move on when answers are substantive enough OR when the user seems done with that topic
- Avoid making the user feel interrogated — pace lightly, comment on what they share, sometimes share Muse's own perspective if appropriate

### Opening sequence

Every onboarding call begins with the same shape:

**Self-introduction** (2–4 sentences):
> *"Hi! I'm Muse. The way this works is — we have voice or text conversations, and I keep track of what matters to you in a kind of personal knowledge base. You can also ask me to do things on your behalf — research a topic, draft an email, that kind of thing. You can rename me and change my voice later in settings. Right now though, I'd love to get to know you a bit."*

(Exact wording lives in the onboarding scaffolding prompt; this is the template.)

**Opener question:**
> *"What brings you to Muse?"* OR *"What were you hoping I could help you with?"*

The opener is intentionally broad — it naturally surfaces goals, work, interests, and current concerns simultaneously, and gives Muse organic openings for capability advertisement (see below).

### Capability advertisement during onboarding

**Slightly proactive but balanced.** The user shouldn't leave onboarding without some sense of what Muse can do, but capability mentions must feel earned by the conversation, never like a sales pitch.

Discipline:
- **Tie every capability mention to a stated need.** If the user mentions an interest in cooking, that's a natural opening to "I can do research on specific topics if you ever want a deep dive — recipes, techniques, that kind of thing." If they mention a busy work schedule, that's the moment for "I can help draft emails or summarize stuff to save you time."
- **No upfront capability menu.** Don't list features in the self-intro beyond the brief hint already there ("ask me to do things on your behalf — research a topic, draft an email, that kind of thing").
- **One capability per natural opening, max.** Don't pile suggestions; let one land before suggesting another.
- **Frame as offers, not pitches.** "If you'd like…" / "I could…" / "Want me to try that?" — never declarative "I can do X for you."

Goal: by call end, the user has heard 2–4 capability mentions naturally interspersed with the conversation, and has accepted at least one (or politely declined) — enough to build a rough mental model of what Muse can do. Without a single moment that felt like a tour.

### Topic coverage — askable vs. emergent

The 9 profile areas split into two groups for onboarding purposes:

**Askable (7 areas)** — Muse may direct conversation toward these:
- **Goals**: at least one short-term + one long-term goal, ideally with the *why*
- **Life-History**: chapter-level narrative — where the user grew up, education, broad strokes of career, key turning points or formative experiences. **Intentionally light at onboarding** ("walk me through the rough shape — we can dig in over time"); depth accumulates organically as biographical references come up in future calls.
- **Health**: current state, anything actively managed (sleep, fitness, nutrition, conditions), how the user thinks about health
- **Work**: current role + organization, what kind of work they do, what's interesting/hard/aspirational about it
- **Interests**: 3–5 things the user is genuinely curious about or enjoys
- **Relationships**: who's important — family, partner, close friends, key colleagues. Names + brief context. (Don't pry into emotionally-loaded territory; just orient.)
- **Preferences**: communication style, how they like to be spoken to, formality, directness, humor

**Emergent-only (2 areas)** — Muse never directs conversation toward these. Their pages get populated from claims that surface naturally during conversation about the askable areas:
- **Values**: captured when the user volunteers them ("I really care about doing meaningful work") OR inferred from how they talk about goals / work / life-history. Asking "what are your values?" feels stilted and produces shallow answers; far better to let them emerge.
- **Psychology**: same logic. "How do you describe yourself cognitively?" lands flat. Far richer signal comes from how the user actually talks about themselves across the askable areas — fan-out routes those claims to `profile/psychology` as warranted.

This is a deliberate split: explicitly asked → directly populated; emergent → backfilled by ingestion via the standard claim-routing rules. Values + Psychology pages may stay light immediately post-onboarding; they thicken over time.

**Scope discipline across overlap-prone areas:**
- **Life-History** = narrative arc + chapters + formative events
- **Relationships** = current important people (family-of-origin overlap is fine — both pages can reference parents, with Life-History narrating + Relationships profiling)
- **Psychology** = current self-model / patterns (emergent)
- **Values** = stated or inferred values (emergent)
- **Work** = current role + ambitions

Some bleed is OK; ingestion routes claims via the fan-out routing rules.

These are guidelines, not requirements. User can refuse or skim any topic.

### Progress tracking

Muse tracks progress internally during the call (no DB persistence required mid-call). The interview's `wiki_log` entry post-call records which topics were "addressed" vs. "skipped" vs. "deferred."

For mid-call progress: Muse maintains a working sense of "covered areas" and references it conversationally — "We've covered your goals and values. Want to talk about your work next, or save that for another time?"

### "Good enough to leave" heuristic

Target call length: ~10 minutes average. Some users naturally take less; some go longer. The wrap heuristic shouldn't push toward longer calls.

Muse wraps onboarding when at least ONE of:
- **4+ of 7 askable profile areas covered substantively** (enough material for fan-out to produce 2+ claims each). Values + Psychology don't count toward this threshold — they're emergent.
- **User explicitly signals done** ("I think that's enough for now," "let's stop here," "I'd rather just start using it")
- **User has been on the call for 15+ minutes** (soft cap — Muse offers to wrap; user can extend if mid-thought)

When wrapping, Muse:
- Briefly summarizes what they covered
- Notes what's still open ("we didn't get into your health or relationships yet — happy to pick that up another time")
- Says goodbye warmly + transitions out

### Resumption + dropped-onboarding handling

Onboarding is **not required to complete in one session.** User can:
- Tap "skip for now" at any point → exits to home with whatever's been covered
- Drop the call (network, app backgrounded, etc.) → standard dropped-call deferred-confirmation flow (§8 Chunk 5)
- Resume later from settings ("complete your profile") → starts a new `call_type='onboarding'` session; Muse references existing profile content + picks up where it left off

There's no separate "onboarding state machine" tracked server-side. The state is implicit in the profile pages' content — empty/light = needs more onboarding; substantive = done. Muse on resumption reads the existing profile pages (preloaded per §8 Chunk 3 even though most onboarding preload is otherwise minimal — for resumption we DO preload existing profile content).

### Trial artifacts

Bumped to V1+ per `backlog.md`. MVP onboarding is a pure interview with no mid-call task kickoff.

### Capability advertisement during onboarding (recap)

See the "Capability advertisement during onboarding" subsection above under "Opening sequence" — slightly proactive, tied to stated needs, no upfront menu. Supersedes the original §8 Chunk 2 framing of "intentionally minimal" — onboarding's actual posture is balanced: not pushy, but the user shouldn't leave without a sense of what's possible.

### Onboarding scaffolding cache

Like generic call-agent scaffolding, the onboarding scaffolding is a static system prompt cached in Gemini explicit cache (§2 prompt-caching strategy). Distinct cache entry from the generic scaffolding; both managed by the worker startup process.

### Post-onboarding ingestion

Standard ingestion runs against the onboarding transcript (per §6 pipeline). Fan-out extracts claims from the user's speech and populates profile sub-pages with sections. The interview is essentially a focused conversation that the ingestion pipeline handles like any other — there's nothing onboarding-specific in the post-call processing.

Agent-scope ingestion also runs (per `specs/agent-scope-ingestion.md`) — Assistant captures initial observations about the user's communication style, energy, areas of interest, etc.

---

## Open / deferred items

- **Voice picker in onboarding**: not at MVP. User gets the default Gemini Live voice. V1+ when custom voices land (`backlog.md`).
- **Persona customization in onboarding**: same — not at MVP. User can edit the Assistant's `user_prompt_notes` in V1+.
- **Onboarding analytics**: V1+ — track completion rate, drop-off points, time-to-good-enough.
- **Multilingual onboarding**: V1+ — MVP is English-only.

---

## Related decisions

- `specs/agents-and-scope.md` — multi-agent data model (default Assistant)
- `specs/fan-out-prompt.md` — claim extraction from the onboarding transcript
- `specs/agent-scope-ingestion.md` — agent-scope observations during onboarding
- `todos.md` §8 — call-agent prompt + onboarding call-type
- `todos.md` §10 — onboarding section (this spec is the SPEC artifact for that section)
- `backlog.md` — trial-artifacts (V1+), persona customization (V1+), voice picker (V1+)
