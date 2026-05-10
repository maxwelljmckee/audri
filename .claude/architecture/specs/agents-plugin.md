# SPEC — Agents plugin

Status: **scaffolding shipped 2026-05-09** (autonomous tranche of v0.2.0). Surface design locked per DP-4 resolution; queue-population + iteration pending.

Mobile-side surface for the per-persona open-items queue. Where the user sees what each agent is "thinking about" between calls — the questions a persona has queued up to ask, and the proactive info-shares it has prepared to introduce. Companion to the `agent_open_items` substrate (v0.2.0 item #3) + the call-side prompt composer (v0.2.0 item #5).

Companion docs: `agents-and-scope.md` (the agent-scope concept underneath), `build-phases/v0.2.0.md` (DP-4 resolution + the autonomic-loop architecture this plugin surfaces), `mobile-app.md` (overall plugin shell pattern).

---

## Purpose

The autonomic loop generates *between-call* content — questions and info-shares each persona prepares for the next conversation. Without a UI surface, that content is invisible to the user, which fails the Transparency principle: Audri is "thinking about you" but the user has no way to see what.

The Agents plugin is that surface. It expresses the second of the four core UX principles directly — the user sees what the system knows, what it's curious about, what it plans to bring up. It also gives the user a relief valve (snooze / dismiss) for items they don't want surfaced, expressing Autonomy/Control.

What it is NOT: a config UI for agents (that's stubbed for V1+), a manual question-seeding surface (V1+ if observed need), or an agent inventory for general management. Scope is intentionally narrow.

---

## Surface map

### Tile

`PluginTile` on the home grid: label "Agents", icon `sparkles-outline`. Tap launches the Agents overlay using the standard scale-from-tile animation.

### Overlay — List screen (entry)

`FlatList` of agent cards. Each card:

- Avatar (placeholder icon today; future: persona-specific imagery)
- Name (e.g. "Audri")
- Persona label (e.g. "Assistant")

Tap a card → push to Detail. Pull-to-refresh wired.

N=1 in v0.2 (the default research-persona "Audri"). Designed to scale: when V1+ adds specialist personas (tutor, coach, etc.), each gets a card here.

### Overlay — Detail screen

Two sections, surfaced in this order:

1. **Configurations** — stubbed placeholder for V1+. Future home for: persona prompt overrides, model/voice preferences, cadence settings (for installable plugins like Dreaming when they land in v0.3).
2. **Open questions** — live read of `agent_open_items` for this agent, filtered to `status IN ('pending', 'surfaced')`. Each row renders:
   - Kind icon (`help-circle-outline` for questions, `bulb-outline` for info-shares)
   - Kind label ("Question" / "Insight")
   - Topic (short label)
   - Body text (the actual question or fact)
   - Dismiss action (sets status='dismissed')

Snooze (status='dismissed' with re-armable timer) is V1+ — for v0.2 dismiss is terminal.

Empty state: *"Nothing on {agent}'s mind yet. Items appear here as the agent reflects on your conversations."*

---

## Interaction model — passive transparency

Per DP-4 resolution (2026-05-09):

- **User does NOT seed questions.** The queue is system-generated only; agent-scope ingestion (v0.2.0 item #4) produces candidates after each call.
- **User can dismiss.** Single-tap close affordance per row. Sets `status='dismissed'`, `resolved_at=now()`. The composer skips dismissed items on subsequent calls.
- **User can review without acting.** Reading the queue is itself a Transparency action — the user sees what's about to be brought up.

Why passive over active: the value proposition of the autonomic loop is that the *system* tracks what to ask. Inviting users to populate the queue manually undercuts that and risks turning the surface into yet-another-task-tracker. If observed need surfaces in V1+ (e.g. user wants to flag a topic for the agent to explore), revisit then.

---

## Data model

Reads from `agent_open_items` via two RxDB hooks (`apps/mobile/lib/rxdb/useAgentOpenItems.ts`):

- `useAgentOpenItems(agentId)` — all items for one persona, sorted priority desc → created_at desc. Used by the Detail screen.
- `useAgentOpenItemsPending(agentId)` — pending only, same ordering. Reserved for future Composer-side reads + a count badge on the agent card.

Writes via `updateOpenItemStatus(itemId, status)` — bumps `updated_at` so push replication picks the change up. Currently invoked only by the dismiss action.

Sort order rationale: priority is the primary axis (composer-supplied), recency breaks ties. The Detail screen renders all (priority + recent first); UI doesn't need an explicit "show oldest" affordance for v0.

---

## Lifecycle visibility

The status enum has six values; only some are surfaced in the UI:

| Status | UI behavior |
|---|---|
| `pending` | Visible in Detail "Open questions" section |
| `surfaced` | Visible (still potentially actionable) |
| `answered` | Filtered out (terminal) |
| `engaged` | Filtered out (terminal) |
| `dismissed` | Filtered out (terminal) |
| `expired` | Filtered out (terminal) |

V1+ candidate: an "Archived" sub-view exposing terminal items so the user can see what's been resolved. Not in v0.2 scope.

---

## Scope boundaries

**In v0.2:** the surface above. Read-only with dismiss action. Pull-to-refresh.

**V1+:**
- Manual question seeding (if observed need)
- Snooze (with re-arm timer)
- Per-persona configurations (model / voice / prompt-prefs)
- Cadence settings for installable plugins (Dreaming etc.)
- Archived sub-view
- Per-card pending count badge
- Multi-persona support (Audri, plus tutors / coaches / etc.)
- Cross-persona views — "everything the system is thinking about right now, across personas"

---

## Open follow-ups

Tracked in `build-phases/v0.2.0.md` outstanding flags:
- Avatar imagery (currently `sparkles-outline` placeholder)
- Home grid layout — 5 tiles in a row sized for 4
- Pending-count badge on each agent card (would read `useAgentOpenItemsPending`)
