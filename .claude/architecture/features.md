# Constellate — Features

A catalog of target features for the product, grouped by area. Items are tagged for **MVP** scope or **V1+** (deferred). For full deferred-work tracking with priority + effort, see `backlog.md`.

---

## Call experience

### Voice calls with Muse — `MVP`
Voice-first conversation with the active agent (Muse / Assistant at MVP). Persists through screen-lock. Initiated via the phone FAB available from any screen.

Two call types at MVP:
- **`generic`** — open-ended conversation; default preload (recent context, index, agent scope).
- **`onboarding`** — scripted-but-conversational interview that seeds the user's profile pages.

### Different call types — `V1+`
Beyond `generic` + `onboarding`:
- **Contextual call** — initiated from a specific page/artifact; that content is added to preload.
- **Task-specific call types** — "daily brief," "brainstorm on X," "thought-partner session." Each gets its own scaffolding variant + preload strategy + call-end flow.

### Mid-call task kickoff — `V1+`
At MVP, all agent-task creation (research etc.) flows through post-call ingestion. V1+ allows mid-call kickoff for selected call types — onboarding's trial-artifacts feature is the first planned use.

### Custom agents — `V1+`
User can create custom personas (Health Coach, Therapist, etc.) with unique names, voices, persona prompts, and private observation wikis. Multi-agent data model is in place at MVP (default Assistant only); custom agents land V1+ with no schema migration.

---

## Activity stream & notifications

### Activity stream — `MVP`
Persistent in-app feed of activity. Combines:
- Background task completions (research finished, etc.)
- Wiki updates (post-call ingestion writes)
- Agent observations (agent-scope ingestion writes)
- Confirmation flows (action items needing review from dropped calls)

### In-app notifications — `MVP`
Toast notifications for terminal task transitions (succeeded, failed). Tap to deep-link to artifact / retry view.

### Push notifications — `V1+`
Expo Push or native APNs/FCM. Per-platform cert management. MVP relies on in-app surfaces; users see notifications next time they open the app.

### Proactive recommendations — `V1+`
Muse identifies patterns + surfaces recommendations:
- Suggested scheduled tasks ("you've asked about AI news 3 mornings in a row — want a daily AI brief?")
- Suggested wiki changes (entity merges, missing connections, page splits)
- Suggested follow-ups from recent calls

### Skills — `V1+`
Context-aware capability suggestions. Pre-defined templates the agent advertises based on what the user is doing (reviewing a research artifact, looking at a project, etc.). Lightweight Skills compose existing primitives (wiki write, plugin invocation, inline generation); heavier Skills graduate to plugins. Solves the prompting-skill barrier by surfacing valuable actions users wouldn't think to ask for.

---

## Navigation & connectivity

### Deep connectivity between artifacts — `MVP foundations / V1+ UI polish`
Every artifact knows its provenance + downstream consumers. From any artifact, the system can traverse upstream (sources) + downstream (artifacts produced from this) + laterally (related material). MVP infrastructure is in place via section-level junction tables; V1+ surfaces this richly in the UI.

### Phone FAB ubiquity — `MVP`
Phone button available from every screen. Tapping starts a call from wherever the user is.

### Contextual-call initialization — `V1+`
Pass current-page / current-artifact context into call start. MVP starts every call from a default state.

---

## Content delivery

### Adaptive delivery channels — `V1+`
For any generated artifact (research, podcast, brief), user can choose a delivery channel:
- **In-app** — filed into the activity stream
- **Short audio clip** — playable in-app or via headphones
- **Email** — delivered to user's inbox
- **Push summary** — notification carries the content

Delivery preferences settable globally / per-task-type / per-schedule.

---

## Scheduled & event-driven content

### Scheduled / recurring tasks — `V1+`
Recurring time-based content (daily news, weekly briefs, scheduled research). Configuration via conversation or settings; pause/resume/edit. Cron / next-run engine via Graphile recurring jobs.

### Event-driven content — `V1++`
Subscribing to real-world change rather than fixed schedule. RSS, topic-change detection, release alerts. Long-term goal.

---

## Knowledge ingestion

### Voice → wiki — `MVP`
Every call's transcript fans out into wiki updates via the ingestion pipeline. Person mentions, project updates, commitment patterns, profile content all flow naturally from conversation.

### Upload sources — `V1+`
User-uploaded files (URLs, PDFs, markdown, images with OCR + vision, audio) ingest into the wiki via the same fan-out pipeline. Mirrors transcript flow. Forces Supabase Storage setup.

### Feeds (content partnerships) — `V1++`
Partner with content organizations (news, etc.) to ingest curated content as user-specific feeds. Revenue-share via partnership accounting.

### Email ingest — `V1++`
Received emails as a context stream. Requires Gmail connector with read scope.

---

## Plugins (capability marketplace)

### Research plugin — `MVP`
Background research on a topic. User asks ("can you research Italian restaurants?"), agent confirms, fan-out creates a research todo, agent_task picks it up, handler runs Pro with web grounding, produces a `research_outputs` row with citations. Surfaces in the Research UI module.

### Podcast plugin — `V1+`
Podcast-style audio generation. Forces binary-artifact + Storage pipeline.

### Email-drafting plugin — `V1+`
Drafts emails for user review + send. Requires Gmail connector. User-confirm-required write policy.

### Calendar-event plugin — `V1+`
Proposes calendar events for user confirmation. Requires Google Calendar connector.

### Brief plugin — `V1+`
Daily / weekly / evening briefs synthesizing recent activity + calendar + tasks.

### Plugin extensibility — `V1++`
Third-party / runtime-installable plugins. Marketplace. Out of scope for V1; registry shape leaves the door open.

---

## Connectors (3rd-party integrations)

### Google connectors — `V1+`
Calendar + Email + Contacts. OAuth flow, token storage in Supabase Vault, refresh + revocation, granted-scopes display, disconnect action.

### Other providers — `V1++`
Linear, Google Drive, Slack, etc. Same pattern.

---

## UX surfaces

### Wiki module — `MVP`
Core UI surface. Browse + edit `wiki_pages` + `wiki_sections`. Virtual folders by `type`. Hierarchy tree within each folder. Search, filter by tag/type. CRUD operations (create, tombstone, edit, merge). WYSIWYG editor.

### Todos module — `MVP`
Core UI surface. Task-management UX over `wiki_pages WHERE type='todo'` joined with `agent_tasks`. Status tabs (pending, in-progress, done, archived), check-off, due dates, sub-tasks via hierarchy, assign-to-agent toggle.

### Research module — `MVP`
Plugin UI for research outputs. Library + detail view + spawn-research affordance.

### Activity-stream + notifications surfaces — `MVP`
In-app feed + toast notifications.

### Call-history surface — `MVP`
List of past calls with summaries; tap into transcript.

### Settings — `MVP`
Account info, plugin enablement, connector management (V1+), persona customization (V1+ for non-default agents; basic Assistant tweaks may sneak in MVP).

### Onboarding — `MVP`
Auto-launches on signup; resumable from settings.

### Graph view — `V1+`
Visualization of the wiki as a graph. Visualization library, default filters, interactions.

### Plugin launcher / capability surface — `V1+`
Browse + enable plugins; connector-required prompts.

---

## Cross-cutting principles

These hold across every feature, MVP and beyond:

- **Every new feature adds to the activity stream.** If Muse did something, the user sees it.
- **Every new artifact is a graph citizen.** It knows its provenance and downstream consumers.
- **Every automation has a manual override.** Schedules pausable, recommendations dismissable, task results editable (where appropriate).
- **Every generated output is filable into the wiki** (or its dedicated artifact table). Knowledge compounds across sessions.
- **Friction proportional to the cost of reversal.** Cheap-to-undo actions silent; expensive actions confirmed.

See `architecture.md` for system design + `todos.md` for the per-decision checklist + `backlog.md` for the V1+ horizon.
