# Constellate — Backlog

Things we plan to do but deferred out of MVP. Centralized here so we don't lose track as we pile "do this later" notes into `todos.md` and `tradeoffs.md`.

Each entry is sortable by **Priority**, **Effort**, and **Type**. Not a commitment of order or timing — just a structured snapshot of the post-MVP horizon.

---

## Legend

**Priority** (urgency once MVP ships)
- **P0** — V1 first wave; highest priority post-MVP
- **P1** — V1, likely inclusion
- **P2** — V1+ beyond; triggered by observed need
- **P3** — Nice-to-have; maybe never

**Effort** (rough size)
- **S** — < 1 day
- **M** — 1–3 days
- **L** — ~1 week
- **XL** — multi-week

**Type** — Feature / Infra / Data model / UX / Observability / Security / Cost-Business / KG maintenance / Tech debt (often combined when an item spans categories)

---

## Features

### Interaction modes

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Text mode (chat) | P0 | M | Feature | Text-based parallel to Call mode; same agent scaffolding, different I/O plumbing. Transcripts same shape as voice. Voice-first users can't always talk (meetings, noisy environments). Source: §9. |
| Ask mode | P2 | M | Feature | Short-question/short-answer path, lighter than full Call. Entry from anywhere in the app. Source: §9. |
| Note mode | P2 | M | Feature | Voice-to-transcript-to-KG bypassing dialogue. Shares ingestion pipeline. Source: §9. |

### Plugin capabilities (beyond MVP `research`)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Trial artifacts during onboarding (mid-call kickoff exception) | P0 | M | Feature + Infra | Originally scoped for MVP but bumped to V1 to keep MVP lean. During onboarding only, agent proactively offers + queues low-cost trial artifacts based on stated interests so they're waiting on the user's home screen post-call. Requires: onboarding-only mid-call tool (`queue_trial_artifact(kind, payload)`); server validates `call_type='onboarding'`; `agent_tasks.is_trial: bool` column for tier-cap exemption; onboarding scaffolding's tool palette declares the tool, generic does NOT. Hard cap 3 trial artifacts per onboarding call. Source: §8 Chunk 4 (originally), §10. |
| **Skills** — context-aware capability suggestions | **P0** | M | Feature + Infra | Pre-defined contextual prompt patterns the agent advertises based on the user's current context (reviewing an artifact, discussing a page, looking at a transcript, etc.). Each Skill is a registered template that composes existing primitives (wiki write via fan-out, plugin invocation, inline generation) — no new artifact infrastructure required for lightweight Skills; heavier ones graduate to plugins. Solves the "users don't know what to ask for" prompting-skill barrier; greatly increases perceived value per session. Sits in a parallel `skillRegistry` alongside `pluginRegistry`. Composes into call-agent prompt Layer 4 (capability advertisement) with trigger-relevance as a 5th availability filter alongside the existing four (System / Tier-granted / User-enabled / Connector-ready). Naming follows Anthropic's existing mental model. Seed set candidates: cheatsheet-from-research (wiki write), brainstorm-next-questions (inline), tangent-research (invokes research plugin), recap-to-email (V1+ Gmail), promote-to-todo (todo write). Source: §8 Chunk 2 (capability advertisement) extension. |
| Agent advertises uninstalled capabilities + self-installs via todo | P1 | M | Feature + Infra | Agent has awareness of the broader system capability set, including plugins the user hasn't installed. When a user expresses an intent that maps to an uninstalled plugin, agent advertises ("I could do that for you if you install the [X] plugin — want me to set that up?") and on confirmation, submits installation as a todo. Removes the friction of "go to plugin directory + install + come back." Capability-availability levels (§11) extend: agent's prompt includes a "could-be-installed" tier alongside the four current levels. Source: §8 Chunk 3 refinement, §15c. |
| Podcast plugin | P1 | L | Feature | Script + audio-file-ref + player UI module. First binary-artifact plugin. Forces Supabase Storage pipeline. Source: §3, §11, §15c. |
| Email-drafting plugin | P1 | L | Feature | Requires Gmail connector. User-confirm-required write policy. Source: §11, §15, §15c. |
| Calendar-event plugin | P1 | M | Feature | Requires Google Calendar connector. User-confirm-required at MVP scope. Source: §11, §15, §15c. |
| Daily/weekly brief plugin | P1 | M | Feature | Aggregates recent activity + wiki state. Source: §11, §15c. |
| Periodic usage + interest review | P2 | M | Feature | Scheduled background pass surfacing "you've been talking about X lately — want a weekly brief on it?" style recommendations. Own prompt + kind. Source: §13. |

### Custom agents

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Custom agent creation UX | P1 | L | Feature | Beyond default Assistant. Name, voice, persona_prompt, user_prompt_notes editing. Voice picker. Source: §15b. |
| Assistant persona customization | P0 | S | Feature | User can rename / adjust voice / append `user_prompt_notes` on the default Assistant. Could sneak in before custom agents proper. |
| Agent deletion semantics | P2 | M | Infra | Tombstone + cascade the agent-scope subtree or block deletion with substantial content. Source: §15b. |
| Mid-session agent switching | P3 | S | Feature | "Actually, talk to the Health Coach about this." Probably forced call-end + new call. Source: §15b. |
| Per-agent onboarding interview | P2 | M | Feature | New custom agents run a truncated interview to seed their private wiki. Source: `specs/agents-and-scope.md`. |

### Knowledge ingestion expansion

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Upload sources pipeline | P1 | XL | Feature | URLs, files (PDF/markdown/text), images (OCR + vision), audio. Mirrors transcript flow. Requires Supabase Storage + per-type extraction. Source: features.md, §3, §6. |
| Feeds as sources (content partnerships) | P2 | XL | Feature | RSS/equivalent ingestion on schedule. Partner revenue-share accounting. Source: §5. |
| Email ingest (received email as context) | P2 | L | Feature | Inbox as a source stream. Requires Gmail connector read scope. Source: §6, §15. |

### Notifications + engagement

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Push notifications | P1 | M | Infra | Expo Push or native APNs/FCM. Per-platform cert management. MVP ships with in-app only. Source: §13. |
| Notifications feed data model | P1 | S | Data model | `notifications(id, user_id, kind, artifact_ref, body, read_at, snoozed_until, …)`. Source: §3, §13. |
| Notification grouping / snooze / dismiss | P1 | M | UX | Design pass on notification feed UI behavior. Source: §13. |
| Deferred confirmation (dropped-call flow) | P1 | M | Feature | Unconfirmed action items from a dropped call surface in notifications for deferred confirmation. Source: §8, §13. |
| Adaptive delivery channels | P2 | L | Feature | Global / per-task-type / per-schedule preferences: in-app, audio clip, email, push-summary. Source: features.md. |

### Scheduled + recurring content

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Scheduled / recurring tasks | P1 | L | Feature + Infra | Configuration (conversational vs. settings), schedule storage, timezone handling. Cron / next-run engine (Graphile recurring jobs likely). Source: §12. |
| Pause/resume/edit schedules | P1 | M | UX | Source: §12. |
| Event-driven content | P3 | XL | Feature | RSS polling, topic-change detection, release alerts. Out of V1 entirely. Source: §12. |

### User-assigned todo capabilities

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Scheduled-reminder firing | P1 | M | Feature | `due_at` on user-assigned todos fires in-app (and V1+ push) notification. Depends on notification infra. Source: §4. |
| Project-scoped todo lists | P2 | S | UX | Already in data model (child `todos` pages under `project` pages). Needs UI surface in the Todos module. Source: §4. |

### Call mode expansion

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Contextual-call initialization from a wiki page / artifact | P1 | M | Feature | Start a call primed on the page the user is viewing. Source: §8. |
| Call-type variants (task-specific calls) | P2 | L | Feature | Generic / contextual / "daily brief" / "brainstorm on X" call types with their own preload + prompt + call-end flow. Source: §8. |
| Mid-call tool set beyond `search_graph` | P2 | M | Feature | Web search, URL fetch, calendar peek. Source: §8. |
| Call resumption after network drop | P2 | L | Feature | Resume or start fresh on reconnect. Source: §8. |
| Audio retention policy | P2 | M | Data model + Infra | MVP keeps transcript-only. Reconsider raw audio retention if (a) transcript quality issues warrant source-review, (b) users want to replay calls, (c) compliance/audit requires it. Adds Supabase Storage bucket per user, retention policy, playback UI. Source: §8 Chunk 5. |
| Reconsider "Muse's speech is not a claim source" invariant | P2 | S | Tech debt | MVP excludes agent turns from commitment extraction (per `specs/fan-out-prompt.md` §4.1) to prevent closed-loop hallucination. Reconsider when: Muse's clarifying restatements ("so you mean X?") followed by user confirmation are losing useful claim signal, OR a confirmation-aware extraction policy ("treat agent turn as claim source if explicitly user-confirmed in next turn") becomes worth the complexity. Source: §8 Chunk 5. |

---

## Infrastructure

### Plugin + registry

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Runtime-installable plugins | P3 | XL | Infra | Plugin registry becomes DB-backed; installable at runtime vs. via code deploy. Deferred until bundle size or install flexibility becomes a real constraint. Source: §11, §15c, tradeoffs. |
| Third-party plugins / marketplace | P3 | XL | Infra | User-authored or marketplace plugins. Source: §15c. |
| UI module registry | P3 | M | Infra | Separate `uiModuleRegistry` for projection-based UI surfaces. Currently YAGNI'd (Wiki + Todos handled as client-side built-ins). Revisit when 3rd projection module emerges. Source: tradeoffs. |

### Queue / background-loop refinements

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Per-user fairness on `agent_tasks` | P2 | M | Infra | If one user's queue pressure starves others, add per-user `queue_name` pattern. Source: §11. |
| Per-kind concurrency caps | P2 | S | Infra | `queue_name='agent_tasks-${kind}'` if a specific kind needs throttling. Source: §11. |
| Handler checkpointing for long tasks | P2 | L | Infra | If LLM retry cost on crashes becomes material, add phased progress + partial-result caching. Source: §11, tradeoffs. |
| Reprocessing flows (transcript re-ingestion) | P2 | L | Infra | Prompt updates warrant re-running old transcripts. Requires dedup strategy (`(user_id, kind, stable_payload_fingerprint)` hash or `pipeline_version` tag). Source: §11. |
| Aggregate failure-rate alerts | P2 | M | Observability | Beyond Sentry per-error alerts, "failure rate > 5% in 5 min" style. Source: §11. |

### Connectors (all V1+)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| `connectors` table + OAuth flow | P1 | L | Infra | Per-user per-service rows, encrypted tokens, refresh flow, scopes, status. Token refresh as scheduled background task. Source: §15. |
| Capability registry (connector capabilities) | P1 | S | Infra | Module mapping `connector_kind → capabilities`. Plugins declare `requiredConnectors`. Source: §15. |
| Gmail integration | P1 | L | Feature + Infra | Google-first. Read vs. write scope decisions. Source: §15. |
| Calendar integration | P1 | L | Feature + Infra | Google-first. Source: §15. |
| Contacts integration | P1 | L | Feature + Infra | Google-first. Imported contacts map onto `person` pages + aliases. Source: §15. |
| Connector UX | P1 | M | UX | Settings screen; per-connector detail; disconnect action; granted-scopes display; connector-write receipts in activity stream. Source: §15. |

### Search expansion

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| `search_graph` implementation (FTS first) | P0 | M | Infra | Postgres full-text search over `wiki_sections.content` + metadata. Source: §18. |
| Embedding pipeline (pgvector) | P2 | XL | Infra | Semantic search. Model choice, compute-on-edit freshness, blended ranking with FTS. Source: §18. |
| Custom `search_google` tool + provider abstraction | P1 | M | Infra | MVP uses Gemini Live's built-in Google search grounding (config flag, no custom tool). Migrate to a custom `search_google` tool with a provider abstraction layer (Tavily likely candidate, alternatives: Brave, SerpAPI, Perplexity) when triggered by per-call cost visibility needs, provider switching needs, or fine-grained budget control. Behavior: server-side tool, snippet-only return, conservative per-turn budget. Source: §8 Chunk 4. |
| `fetch_url` tool (read full URL content) | P2 | M | Feature + Infra | Beyond Google snippets — actually fetch + clean + extract URL contents for deeper grounding. Adds HTML extraction (Readability or similar), paywall handling, image/video skipping. Lets Muse summarize articles directly. Source: §8 Chunk 4. |

### Recent-activity cache

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Recent-activity materialized view or cache table | P2 | M | Infra + Data model | MVP computes recent activity (last N calls + wiki updates + completed artifacts + todos) via fresh query against `wiki_log` + `call_transcripts` + `agent_tasks` on each call start. When call-start latency becomes noticeable or the activity-stream UI (V1+) shares the same data, promote to a materialized view or dedicated cache table refreshed on event writes. Source: §8 Chunk 1. |

### Observability expansion

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| PostHog server-side events for metrics | P1 | S | Observability | Instrument task-lifecycle events. Dashboards follow. Source: Chunk 5 decisions, tradeoffs. |
| Dedicated log aggregator | P2 | M | Observability | Datadog / Logtail / Axiom / Grafana Loki. Replaces Render built-in when query needs or volume demand it. Source: §11, Chunk 5. |
| Distributed tracing (OpenTelemetry) | P3 | L | Observability | When correlation IDs in logs aren't enough. Source: §11, Chunk 5. |
| Admin triage dashboard | P1 | M | Observability | Failed-task list + aggregate metrics + bulk retry actions. MVP uses Sentry + SQL. Source: §11, Chunk 5. |

### Storage

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Supabase Storage bucket layout | P1 | M | Infra | Deferred to V1 (no MVP binary assets); forced by podcasts. Source: §2. |

### Rate limiting + abuse

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Rate limiting | P1 | M | Security | Per-user call starts, task triggers, upload rates. Source: §20. |
| Abuse / quota ceilings | P1 | M | Security | Prevent runaway inference costs. Source: §20. |

---

## Data model

### Artifact tables (V1)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| `podcasts` table + Storage bucket | P1 | M | Data model | `{ id, user_id, agent_tasks_id, script, audio_ref, duration_s, chapters jsonb, speakers jsonb, generated_at, tombstoned_at }`. Source: §3. |
| `email_drafts` table | P1 | S | Data model | `{ id, user_id, agent_tasks_id, recipient, subject, body, connector_id, status, sent_at, provider_message_id, generated_at, tombstoned_at }`. Source: §3. |
| `calendar_events` table | P1 | S | Data model | `{ id, user_id, agent_tasks_id, connector_id, title, start_at, end_at, description, attendees, status, provider_event_id, generated_at, tombstoned_at }`. Source: §3. |
| `briefs` table | P1 | S | Data model | `{ id, user_id, agent_tasks_id, kind, content, period_start, period_end, generated_at, tombstoned_at }`. Source: §3. |
| Per-artifact-kind junctions (when re-ingestion lands) | P2 | S | Data model | `wiki_section_research`, `wiki_section_briefs`, etc. Created per-kind when that kind opts into `reingestsIntoWiki: true`. Source: §3, §5. |

### Auxiliary tables

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Upload / ingested-source table | P1 | M | Data model | Raw file ref, mime type, provenance, processing status. Required for uploads pipeline. Source: §3, §6. |
| Proposed action-item table | P2 | M | Data model | User-confirmed vs. pending-confirmation rows from call-end flow, linked to originating transcript. Source: §3. |
| Recommendation table | P2 | M | Data model | Reuse notifications or dedicated table. Kinds: schedule-proposal, split-proposal, follow-up, merge-proposal. Source: §3. |
| Schedule / recurring-task table | P1 | M | Data model | Cron spec, task kind, params, delivery prefs, pause state, next-run, owner. Source: §3, §12. |

### Schema maintenance

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Full data model review pass | P0 | L | Data model + Tech debt | Audit types, relations, indexes, RLS policies, history retention once outstanding decisions resolve. Source: §3. |
| Indexes | P0 | M | Data model | Explicit plan for `wiki_pages(user_id, scope, type)`, slug lookups, `parent_page_id` descents, `wiki_sections(page_id, sort_order)`, FTS on `wiki_sections.content`, frontmatter jsonb GIN. Source: §3. |
| History retention policy | P2 | S | Data model | When do we switch from full snapshots to diffs or periodic snapshots. Source: §3. |
| Tombstone retention | P2 | S | Data model | Permanent or GC after N days. Source: §3. |
| Alias indexing | P1 | M | Data model | Trigram index on concatenated aliases vs. separate `aliases` table. Speeds voice disambiguation. Source: §3. |
| `wiki_log` retention / rollup | P2 | S | Data model | Policy for log growth. Source: §4. |

---

## UX / UI

### Core surfaces

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Wiki browse UI | P0 | L | UX | Virtual folders by `type`, hierarchy tree within each, search, filter by tag/type. Source: §19. |
| CRUD UI | P0 | L | UX | Create, tombstone, edit, merge (entity disambiguation), bulk ops, undo stack, "New Project" + "Move under…" affordances. Source: §19. |
| WYSIWYG editor choice | P0 | M | UX | Lexical / TipTap / ProseMirror / custom markdown. Source: §19. |
| Todos UI module | P0 | M | UX | Task-management UX over `wiki_pages WHERE type='todo'` + joined `agent_tasks`. Status tabs, check-off, due dates, sub-tasks, assign-to-agent. Source: §4, §15c. |
| **Projects UI module + seed root page** | P1 | M | Feature + UX + Data model | Top-level "Projects" UI surface alongside Profile, Wiki, and Todos — dedicated space for stuff the user is working on. Projection over `wiki_pages WHERE type='project'` with hierarchy expansion (each project's sub-pages: tasks, notes, sources, etc. visible under it). Includes seed `projects` root page (V1 migration adds the row alongside existing `profile` + `todos` roots). New projects default to that parent; user can reparent freely. Lifecycle TBD — likely just `active` vs. `archived` (buckets, frontmatter flag, or simple tombstone-archive — design at spec time). Pairs with project pinning (P1 above) for preload prioritization. Same projection-module pattern as Wiki + Todos (no plugin registry, client-side query logic). Source: user request 2026-04-26. |
| Graph view | P2 | L | UX | Visualization library, default filters, interactions. Source: §19. |

### Activity + notifications surfaces

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Activity-stream UI | P1 | M | UX | Mixed-type feed with grouping + snooze. Source: §19. |
| Notifications UI | P1 | M | UX | In-app screen + push payload shape (once push lands). Source: §19. |
| Call-history UI | P1 | M | UX | Listing, filtering, linking back to spawned artifacts. Source: §19. |

### Contextual affordances

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Phone FAB ubiquity | P0 | S | UX | Available from every screen. Source: §19. |
| Contextual-call initialization | P1 | M | UX | Pass current-page context into call start. Source: §19. |
| Contextual source creation | P1 | M | UX | Upload source directly from a wiki page; spawn research/podcast from a source; drill from transcript to touched pages. Source: §5. |
| Project pinning | P1 | S | UX + Data model | User explicitly pins `project` pages as "active"; feeds preload prioritization. Boolean column on `wiki_pages` (or dedicated pins table). MVP uses activity-derived hot-set; V1 layers explicit pinning over it for stable user control. Source: §8 Chunk 3, §19. |
| User-pinned wiki pages (general) | P1 | S | UX + Data model | Beyond projects, let users pin any wiki page they want preloaded reliably (a person they're tracking closely, a concept they're studying). Same boolean-column or pins-table mechanism as project pinning. Source: §8 Chunk 3. |
| Plugin launcher UI | P2 | S | UX | Prototyped but confirm MVP role. Source: §19. |

### Persona + agent UX

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Agent persona-editing UX | P1 | M | UX | Rename, voice picker, `user_prompt_notes` editor. Source: §15b. |

### Mobile-app polish (spawned from `specs/mobile-app.md`)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Theme switcher + light-mode toggle | P1 | M | UX | All five Liquid Glass variants (Azure / Aurora / Ember / Verdigris / Void) tokened from MVP; V1 ships the picker UI + light-mode variants. Source: `specs/mobile-app.md` Themes. |
| Avatar tap → account / settings menu | P1 | S | UX | Top-right home avatar is a stub at MVP; V1 surfaces the account / settings menu. Source: `specs/mobile-app.md`. |
| Mic-mute UI on call screen | P2 | S | UX | Distinct visual state for muted mic mid-call. Source: `specs/mobile-app.md` Call screen. |
| In-call transcript feed | P2 | M | UX | Live transcript visible mid-call, behind a setting. Most users won't want it (reading-while-talking is anti-pattern). Source: `specs/mobile-app.md` Call screen. |
| Per-screen status-bar hiding | P3 | S | UX | Full-immersion mode for call screen. Source: `specs/mobile-app.md`. |
| Add-plugin tile / plugin marketplace surface | P3 | XL | UX + Feature | Discoverable surface to enable + install plugins. Tied to runtime plugin installation (already P3). Source: `specs/mobile-app.md`. |

### Sync + offline

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Conflict resolution policy | P0 | M | UX + Infra | User edits client-side while AI writes server-side. Last-write-wins vs. server-wins vs. merge. Source: §3. |
| Offline behavior | P2 | L | UX + Infra | What user can do disconnected; how edits queue + replay. Source: §3. |
| Initial hydration strategy | P0 | M | UX + Infra | Full dump on first login vs. paginated backfill + realtime. Source: §3. |

---

## Observability (V1+ beyond what's in MVP)

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| PostHog server-side task-lifecycle events | P1 | S | Observability | See Infrastructure > Observability expansion. |
| Aggregate failure-rate alerts | P2 | M | Observability | See Infrastructure. |
| Admin triage dashboard | P1 | M | Observability | See Infrastructure. |
| Cost observability in-app | P1 | M | Observability + UX | Per-user cost breakdown by service ("where my tokens went"). Depends on pricing model (§17b). Source: Chunk 5. |
| Cost anomaly detection | P2 | M | Observability | Alert on user-level spikes. Source: Chunk 5. |
| Expanded PII redaction | P2 | S | Observability + Security | Grow the redaction field list as leaks are observed. Source: Chunk 5, tradeoffs. |
| Distributed tracing | P3 | L | Observability | See Infrastructure. |

---

## Security + Compliance

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| RLS policy set | P0 | M | Security | Write the actual policies per table including write paths. Source: §3. |
| Agent-scope leak-prevention tests | P0 | M | Security | Test suite + audit trail for any endpoint that could return agent-scope content. Source: §3, §20. |
| Cross-agent leakage tests | P1 | S | Security | Verify per-agent partitioning; agent A can't read agent B's subtree. Source: `specs/agents-and-scope.md`, §20. |
| Auth methods decision | P0 | S | Security | Email+password, Apple, Google — confirm which. Source: §20. |
| Account deletion flow | P1 | L | Security | Tombstone vs. hard-delete of all user data. Source: §20. |
| Data export | P2 | L | Feature + Security | "Download as git repo / zip of markdown" portability. Source: §20. |
| Secret management | P0 | S | Security | Server env vars + Supabase Vault for per-user tokens. Source: §20. |
| Token / secret storage for connectors | P1 | S | Security | Supabase Vault vs. server env vs. per-user encrypted. Lean Vault. Source: §15. |
| Graceful cleanup on account deletion during in-flight tasks | P2 | M | Security + Infra | Orphan-artifact cleanup. Source: §11. |

---

## Cost / Business

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Subscription tiers + pricing model | P0 | L | Cost-Business | Tiered subscription with gated usage vs. PAYG vs. hybrid. Source: §17b. |
| Usage events table | P0 | M | Data model + Cost | Full schema per §17b. Needed early even if pricing isn't decided — data accumulates for later analysis. |
| Rollup / summarization strategy | P1 | S | Cost-Business | Nightly `usage_daily` rollup for dashboard queries. Source: §17b. |
| Tier gating integration with `agent_tasks` | P1 | M | Cost-Business | `enqueueAgentTask()` wrapper checks tier caps. Deferred until pricing model lands. Source: §11, §17b. |
| Billing provider (Stripe) | P1 | L | Cost-Business | Not urgent until close to monetization. Source: §17b. |
| Quota enforcement points | P1 | M | Cost-Business | Call start, ingestion, plugin dispatch, upload endpoint, agent creation. Source: §17b. |
| Batch API usage for non-latency tasks | P2 | M | Cost-Business | Overnight briefs, bulk reprocessing. Source: §17. |
| Regeneration debouncing | P2 | S | Cost-Business | Summary + index regen triggered on write but coalesced. Source: §17. |
| Per-agent cost attribution | P2 | S | Cost-Business | `agent_id` on usage_events already carries this; surface V1+. Source: §15b. |

---

## KG Maintenance

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Linting / healthcheck background flow | P1 | L | KG maintenance | Cadence, triggers, checks (orphans, contradictions, stale claims, missing cross-refs, split candidates), autonomous-action scope vs. surfaced recommendations. Source: §7. |
| Auto-split long pages | P1 | M | KG maintenance | Scheduled lint scans for pages exceeding `MAX_LENGTH` (~2k words), proposes or executes nested split. Autonomous vs. confirmation-required (lean confirmation). Source: §7. |
| Auto-merge / entity-merge detection | P2 | L | KG maintenance | Detect near-duplicate pages / fragmented entity references; propose merging. Source: §7. |
| Cluster-to-project elevation | P2 | M | KG maintenance | Detect when related notes/concepts have grown into an implicit project; propose creating a `project` parent + reparenting the cluster. Source: §7. |
| Broken-wikilink repair | P2 | S | KG maintenance | Autonomous fix vs. recommendation. Source: §7. |
| Proactive-recommendation prompts (per kind) | P1 | M | KG maintenance | One per recommendation kind (scheduling, split, follow-up, merge). Source: §13. |
| Notes refactoring policy | P3 | M | KG maintenance | Should AI migrate content from freeform `note` pages onto canonical pages over time. Source: §4. |
| Bidirectional lookup performance | P2 | S | KG maintenance + Infra | Materialized view for reverse lookup (source → pages) at high-volume scale. Source: §5. |

---

## Tech debt + revisit flags

| Name | Priority | Effort | Type | Description |
|---|---|---|---|---|
| Architecture.md sync | P0 | L | Tech debt | Make it the authoritative reference once production build begins. Currently substantially stale (see drift catalog). Source: §23 step 17. |
| Features.md sync | P0 | M | Tech debt | Lighter drift than architecture.md but missing custom agents, text mode, connectors/plugins as first-class. Source: §23 step 17. |
| Kind-registry = DB-backed | P3 | M | Tech debt | Revisit when runtime plugin installation becomes a real requirement. |
| UI module registry | P3 | M | Tech debt | Revisit when a 3rd projection module emerges (People view, Timeline view, saved-view mechanism). |
| `input_snapshot` on `agent_tasks` | P3 | S | Tech debt | Revisit if stale-context issues on mid-flight edits become user-visible. |
| Ghost recovery: don't count as attempt | P3 | S | Tech debt | Revisit if infra failures become common enough that conflating with handler failures is unfair. |
| Failed-task dedicated `todos/failed` bucket | P3 | S | Tech debt | Revisit if failure clutter hurts the pending-todo view. |
| Checkpointing for handler retries | P2 | L | Tech debt | Revisit if LLM retry cost on failures becomes material. |
| Restated-facts silent skip | P3 | S | Tech debt | Revisit if eval transcripts reveal Pro dropping actual signal framed as "already in wiki." |
| Flat index dump for Flash candidate retrieval | P2 | L | Tech debt | Refactor to retrieval-pre-filtered subset when wiki size breaks the full-dump. |
| Slug-only touched payload | P3 | S | Tech debt | Revisit if eval debugging needs per-flag rationale; add optional `reason` field for eval runs. |
| Artifact tombstone cascade for cited wiki sections | P3 | S | Tech debt | Wiki sections keep snippet + null the `ancestor_id`. Revisit if this causes UI weirdness. |
| Abstract regeneration on cosmetic-only edits | P2 | S | Tech debt | Decide whether pure reorders/metadata edits trigger abstract regen. Cost-driven. Source: §4. |
| Per-entity polymorphic artifact table | P3 | M | Tech debt | Reconsider if per-kind junction tables proliferate and share ~80% schema. Unlikely. Source: tradeoffs. |

---

## How to use this doc

- When a decision lands "defer to V1+" in `todos.md` or `tradeoffs.md`, add an entry here with source reference.
- Before each new planning cycle (V1 kickoff, V2 kickoff), sort by priority to pick what lands in the cycle.
- Each entry should link back to the originating decision in `todos.md` / `tradeoffs.md` / a spec via "Source: …".
- Re-priority as understanding changes. An entry may move from P2 to P0 if a user behavior pattern makes it urgent, or from P1 to P3 if it turns out not to matter.
- Not a commitment — items may be dropped entirely when they turn out not to deliver. Move those to a "Rejected" section with a note on why.
