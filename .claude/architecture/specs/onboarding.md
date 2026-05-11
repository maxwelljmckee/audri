# SPEC — Onboarding interview + wiki seeding protocol

Status: **draft** — design rules locked across all chunks. Prompt-text drafting + worked examples + evals remain. **v0.2 rework landed 2026-05-11:** opener inverted to current-life-first, self-intro reframed as "second brain," capability advert lists the four MVP promises (capture / research / briefs / connectors; dreaming line stays cut per DP-2). See "v0.2 changes" below.

The onboarding interview is the user's first interaction with Audri. It's a Gemini Live call (`call_type='onboarding'`) with a specialized scaffolding that guides Audri through a structured-but-conversational flow to fill out the user's profile pages. The flow runs after a server-side seed transaction populates baseline wiki structure.

This SPEC covers two things:
1. **Wiki seeding protocol** — what gets created in the DB at signup (pre-interview state)
2. **Interview design** — how Audri navigates the conversation, tracks progress, and decides when to wrap up

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

The default Assistant persona prompt establishes Audri's baseline voice — friendly, warm, concise, curious, honest. Custom persona prompts arrive V1+ via custom-agent UX.

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

Audri runs a **structured-but-conversational** interview. Not a rigid scripted Q&A; not freeform chat. Topics are scoped (a subset of the profile sub-areas) but the order, depth, and conversational style adapt to the user.

Onboarding scaffolding instructs Audri to:
- Open with the standard self-introduction (see below) followed by the opener question
- Follow the user's lead from there — pick transitions based on what they share
- Ask follow-up questions when answers are vague
- Move on when answers are substantive enough OR when the user seems done with that topic
- Avoid making the user feel interrogated — pace lightly, comment on what they share, sometimes share Audri's own perspective if appropriate

### Opening sequence (v0.2)

Every onboarding call begins with the same shape:

**Self-introduction** (2–4 sentences, "second brain" framing):
> *"Hi, I'm Audri — think of me like your second brain. You tell me stuff and I remember it for you, and when we hang up I'll record everything we talked about in your personal notes. I can do other things too — research topics for you, put together daily briefs or weekly recaps. Down the road you'll be able to plug me into your email, schedule, and meeting apps to help with work too."*

(Exact wording lives in the onboarding scaffolding prompt; this is the template.)

**Opener — current-life entry point:**
> *"The best way to start is just to start. Tell me about what's going on in your life right now. Could be your relationships, a project you're working on, a topic you want to learn more about, anything really. I'll try and find ways of helping out where I can."*

**Why current-life-first.** Earlier drafts opened with life-history ("walk me through the rough shape of your life"). Field-test feedback (Max, 2026-05-09): asking for narrative work upfront with no payoff in sight is the wrong opener. Inverting to current-life-first gives Audri live material to immediately demonstrate value against (capture a thought, queue a research task, surface a relevant connection) — the system's usefulness lands in the first call, not in some imagined future one. Life-history depth accumulates organically over future calls.

Acceptable variations Audri can riff on:
- "Tell me about what's going on in your life right now."
- "What's on your mind these days?"
- "What are you in the middle of? Could be a project, something you're learning, something going on with people in your life — anywhere."

If the user gives a one-line answer or seems tentative, Audri offers a shorter, more concrete prompt rather than retreating to broad framings: "What were you doing this morning? What's been taking up your headspace?"

### Capability advertisement during onboarding

**Slightly proactive but balanced.** The user shouldn't leave onboarding without some sense of what Audri can do, but capability mentions must feel earned by the conversation, never like a sales pitch.

Discipline:
- **Tie every capability mention to a stated need.** If the user mentions an interest in cooking, that's a natural opening to "I can do research on specific topics if you ever want a deep dive — recipes, techniques, that kind of thing." If they mention a busy work schedule, that's the moment for "I can help draft emails or summarize stuff to save you time."
- **No upfront capability menu.** Don't list features in the self-intro beyond the brief hint already there ("ask me to do things on your behalf — research a topic, draft an email, that kind of thing").
- **One capability per natural opening, max.** Don't pile suggestions; let one land before suggesting another.
- **Frame as offers, not pitches.** "If you'd like…" / "I could…" / "Want me to try that?" — never declarative "I can do X for you."

Goal: by call end, the user has heard 2–4 capability mentions naturally interspersed with the conversation, and has accepted at least one (or politely declined) — enough to build a rough mental model of what Audri can do. Without a single moment that felt like a tour.

### Topic coverage — askable vs. emergent (v0.2 priority order)

The 9 profile areas split into two groups for onboarding purposes. Within the askable set, v0.2 reorders priority to put current-life-first (paired with the opener change above):

**Current-life askable (lead with these — primary first-call material):**
- **Work**: current role + organization, what kind of work, what's interesting / hard / aspirational right now
- **Projects + interests**: what they're actively working on, learning, building, exploring. Both serious and casual. 3–5 things.
- **Relationships**: who's important right now — family, partner, close friends, key colleagues. Names + brief context. Don't pry; just orient.
- **Goals**: short-term + long-term, ideally with the *why*. Often emerges naturally from work + projects conversation.

**Background askable (cover when natural opening appears; skip without anxiety):**
- **Life-History**: chapter-level — where they grew up, broad strokes of career, key turning points. **Don't push on the first call**; if it comes up organically, great; if not, future calls fill it in. Lighter at onboarding than the prior spec implied.
- **Health**: current state, anything actively managed (sleep, fitness, nutrition, conditions). Can feel intrusive if asked unprompted — let it surface from goals or work-stress mentions.
- **Preferences**: communication style, formality, directness, humor. Mostly emergent — Audri observes how the user talks and adapts, rather than directly asking.

**Emergent-only (2 areas)** — Audri never directs conversation toward these. Their pages get populated from claims that surface naturally during conversation about the askable areas:
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

Audri tracks progress internally during the call (no DB persistence required mid-call). The interview's `wiki_log` entry post-call records which topics were "addressed" vs. "skipped" vs. "deferred."

For mid-call progress: Audri maintains a working sense of "covered areas" and references it conversationally — "We've covered your goals and values. Want to talk about your work next, or save that for another time?"

### "Good enough to leave" heuristic

Target call length: ~10 minutes average. Some users naturally take less; some go longer. The wrap heuristic shouldn't push toward longer calls.

Audri wraps onboarding when at least ONE of:
- **3+ of the current-life-first askable areas covered substantively** (Work / Projects+Interests / Relationships / Goals). Background areas (Life-History / Health / Preferences) don't count toward this threshold — they accumulate organically over future calls. Values + Psychology don't count either — they're emergent.
- **User explicitly signals done** ("I think that's enough for now," "let's stop here," "I'd rather just start using it")
- **User has been on the call for 15+ minutes** (soft cap — Audri offers to wrap; user can extend if mid-thought)

When wrapping, Audri:
- Briefly summarizes what they covered
- Notes what's still open ("we didn't get into your health or relationships yet — happy to pick that up another time")
- Says goodbye warmly + transitions out

### Resumption + dropped-onboarding handling

Onboarding is **not required to complete in one session.** User can:
- Tap "skip for now" at any point → exits to home with whatever's been covered
- Drop the call (network, app backgrounded, etc.) → standard dropped-call deferred-confirmation flow (§8 Chunk 5)
- Resume later from settings ("complete your profile") → starts a new `call_type='onboarding'` session; Audri references existing profile content + picks up where it left off

There's no separate "onboarding state machine" tracked server-side. The state is implicit in the profile pages' content — empty/light = needs more onboarding; substantive = done. Audri on resumption reads the existing profile pages (preloaded per §8 Chunk 3 even though most onboarding preload is otherwise minimal — for resumption we DO preload existing profile content).

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

## v0.2 changes (2026-05-11)

Three coordinated revisions to the prior onboarding design:

1. **Opener inverted to current-life-first.** Old: "where are you from, what's your story so far" (life-history-first). New: "tell me about what's going on in your life right now." Rationale: asks the user to do narrative work upfront with no payoff in sight is the wrong opener; current-life gives Audri immediate material to demonstrate value against.
2. **Self-intro reframed as "second brain."** Old: "voice-first AI assistant... voice or text conversations." New: "think of me like your second brain. You tell me stuff and I remember it for you, and when we hang up I'll record everything in your personal notes." Captures what Audri does in one line and explicitly names the after-call recording so the user trusts the conversation isn't ephemeral.
3. **Capability advert lists four MVP promises explicitly.** Capture (always-on), Research (shipped), Briefs/recaps (forward-looking, v0.3+), Connectors (forward-looking, v0.3+). Dreaming line stays cut per DP-2 (returns when v0.3 ships dreaming).
4. **Topic priority reordered.** Within the askable set, current-life areas (Work / Projects+Interests / Relationships / Goals) lead; background areas (Life-History / Health / Preferences) cover only when natural openings appear. Wrap threshold dropped from "4 of 7 askable" to "3 of 4 current-life askable" — background no longer gates wrap.

These changes track promises Audri seeds in the onboarding script — see `build-phases/v0.2.0.md` "Promises seeded by onboarding (tracking)" for the cross-phase delivery commitments those four capabilities create.

---

## Related decisions

- `specs/agents-and-scope.md` — multi-agent data model (default Assistant)
- `specs/fan-out-prompt.md` — claim extraction from the onboarding transcript
- `specs/agent-scope-ingestion.md` — agent-scope observations during onboarding
- `todos.md` §8 — call-agent prompt + onboarding call-type
- `todos.md` §10 — onboarding section (this spec is the SPEC artifact for that section)
- `backlog.md` — trial-artifacts (V1+), persona customization (V1+), voice picker (V1+)
