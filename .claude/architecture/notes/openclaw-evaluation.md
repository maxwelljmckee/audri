# OpenClaw Integration Evaluation

**Date:** 2026-05-07
**Status:** Decision document — pending user review
**Author:** Claude (research pass against `~/dev/openclaw-docs/docs/` + GitHub org)

## Executive summary

OpenClaw is a substantively built, MIT-licensed, self-hosted multi-channel agent gateway. The ecosystem is real: 54 repos in the org, 132 bundled extensions, 50+ provider plugins, 25+ messaging-channel plugins, a community skills marketplace (ClawHub) with 52.7k tools, and a set of standalone Go/Swift CLIs that constitute the productivity-connector layer (`gogcli` for Google Suite at 7.2k stars, `notcrawl` for Notion, `remindctl` for Apple Reminders, `imsg` for iMessage, `wacli` for WhatsApp, `Peekaboo` for macOS screenshots, `AXorcist` for macOS Accessibility).

**My earlier dismissals were wrong on three counts:**
1. The connector ecosystem the OpenClaw agent pitched does exist — not as bundled plugins, but as standalone CLIs with brew/docker installs, JSON output, and OAuth/keyring built in.
2. Their `memory-wiki` plugin is a real, provenance-rich knowledge layer with structured claims, contradictions, dashboards, and intent-aware search modes — substantively comparable to Audri's wiki and ahead in some places.
3. Multi-tenancy via per-agent isolation in a single Gateway is supported natively. The "fleet of containers" pitch from the OpenClaw agent in the prior session was over-stated; one Gateway can host many agents, each with its own workspace, auth profiles, and session store.

**My recommendation is Path 1 (cherry-pick CLIs, don't pivot architecture)**, with a clear-eyed argument for why Path 2 (full pivot) is also defensible if you want a different long-game. Both are valid; the wrong move is the murky middle.

---

## Verified facts about OpenClaw

These are grounded in docs read or GitHub API confirmed.

### Repo + ecosystem
- Main repo `openclaw/openclaw`: 369k stars, 76k forks, created 2025-11-24, MIT, TypeScript. Daily commit cadence with ~25 visible top contributors. Star count is improbably high for a 5-month-old project; treat the *engineering reality* (active multi-language org, real code, broad capability surface) as the signal, not the star count itself.
- 132 bundled extensions in `openclaw/extensions/`. Composition: ~80% AI providers, ~15% messaging channels, ~5% tools/memory/utility plugins.
- ClawHub (`openclaw/clawhub`, 8.5k stars) is a real TanStack/Convex web app with vector search, telemetry, moderation, and a unified skills + plugins catalog. Native CLI for publish/install/sync.
- Standalone connector CLIs are individual Go/Swift binaries, distributable via brew/docker, MIT-licensed:
  - `gogcli` (Gmail/Calendar/Drive/Contacts/Docs/Sheets/Slides/Forms/Apps Script/Tasks/People/Classroom/Chat) — production-grade
  - `notcrawl` (Notion → SQLite + normalized markdown, FTS5, git-share publishing)
  - `remindctl` (Apple Reminders), `imsg` (iMessage), `wacli` (WhatsApp), `discrawl` (Discord)
  - `Peekaboo` (macOS screenshots + visual Q&A), `AXorcist` (macOS Accessibility chainable queries)
  - `goplaces` (Google Places), `spogo` (Spotify), `gitcrawl` (GitHub issues/PRs)

### Architecture
- Single long-lived Gateway process. WebSocket protocol for clients/nodes; HTTP for API surface.
- Multi-agent within one Gateway: each agent has isolated workspace (`~/.openclaw/agents/<id>/agent/`), auth profiles, session store, model config, sandbox + tool policies, skill allowlists. Routing via bindings: `(channel, accountId, peer) → agentId`.
- Gateway HTTP exposes:
  - `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models` (OpenAI-compatible)
  - `/tools/invoke` (single-tool direct invocation)
  - WebSocket for streaming events
- Auth model: shared-secret bearer auth at the Gateway level. Routes within (per-agent) are addressed via `model: "openclaw/<agentId>"` or `x-openclaw-agent-id` header. **No per-user scoping at the HTTP layer** — operator-trust only. This is the trust boundary.
- App SDK at `@openclaw/sdk` (separate from plugin SDK) for external Node clients to drive the Gateway over WS.

### Memory subsystem (`memory-core` + `memory-wiki`)
- Default storage: per-agent SQLite at `~/.openclaw/memory/<agentId>.sqlite` with FTS5 keyword + vector search (sqlite-vec) + hybrid merge.
- Embedding providers auto-detected: OpenAI / Gemini / Voyage / Mistral / DeepInfra / Ollama / local (GGUF). MMR, temporal decay, multimodal (image+audio via Gemini).
- `MEMORY.md` (long-term) + `memory/YYYY-MM-DD.md` (daily) + `DREAMS.md` (consolidation diary). Plain markdown files, agent edits via tools.
- **`memory-wiki` plugin** is the closest analog to Audri's wiki:
  - Typed entity pages (`person`, `team`, `system`, `project`, `concept`)
  - Structured claims with `id/text/status/confidence/evidence[]/updatedAt`
  - Per-page provenance, contradictions, freshness, open questions
  - Dashboards: open-questions, contradictions, low-confidence, stale-pages, person-agent-directory, relationship-graph
  - Wiki-native tools: `wiki_search`, `wiki_get`, `wiki_apply`, `wiki_lint`
  - Search modes by intent: `find-person`, `route-question`, `source-evidence`, `raw-claim` — **conceptually identical to our Conversational Routing postures**
  - Bridge mode: imports memory-core artifacts into compiled wiki digests
  - Optional Obsidian render mode
- **Active memory plugin**: pre-reply blocking sub-agent that searches memory before the main reply, returns a bounded summary, injects it as hidden system context. This is exactly Audri's preload + Flash-retrieval pattern, generalized.
- **Dreaming**: opt-in background consolidation. Light/Deep/REM phases. Promotes durable items into `MEMORY.md` based on weighted signals (frequency, relevance, query diversity, recency, consolidation, conceptual richness). Has a `DREAMS.md` Dream Diary for human review.
- Memory backends: `memory-core` (SQLite default), `memory-qmd` (sidecar with reranking + query expansion), `memory-honcho` (cross-session AI-native memory, user modeling), `memory-lancedb` (LanceDB-backed with auto-recall/auto-capture).

### Plugin SDK
- Capability model: 13+ registration types covering text inference, speech, realtime voice/transcription, media understanding, image/music/video gen, web fetch/search, channels, memory, gateway discovery.
- Hook system: 25+ typed lifecycle hooks (`before_model_resolve`, `before_prompt_build`, `before_tool_call`, `tool_result_persist`, `message_received/sending/sent`, `session_start/end`, `before_compaction`, `agent_end`, etc.). Decision semantics with `block`/`cancel`/`requireApproval`. Per-hook timeouts.
- Runtime helpers (`api.runtime.*`): TTS, media understanding, image gen, web search, subagent spawn/wait, embedded agent runs, LLM completions with policy, node invoke, session-store helpers, persistent keyed storage, secret-ref resolution.
- Native plugins run in-process with full Gateway trust. **No sandboxing for native plugins** — same trust as core code. Skills (markdown bundles) are safer; ClawHub skills are content packs.
- Context engine plugin slot (one active engine): pluggable context assembly + compaction with `ingest/assemble/compact/afterTurn` lifecycle. This is the "ingestion pipeline shape" abstracted.

### Voice
- `voice-call` plugin is the telephony bridge (Twilio/Telnyx/Plivo/mock). Uses Gemini Live as a bundled realtime voice provider. Concepts ship out of the box that we built bespoke:
  - `realtime.agentContext` — inject agent identity + workspace files into realtime provider instructions at session setup
  - `realtime.fastContext` — search indexed memory before calling consult agent (latency-friendly memory pre-injection)
  - `openclaw_agent_consult` — built-in tool that lets the realtime model drop into the full reasoning agent for deeper work
  - `realtime.toolPolicy: "safe-read-only"` — restrict consult-agent tools to read/search-only
  - `consultPolicy: "substantive"` — when realtime should answer directly vs. consult
- This is **Audri's voice architecture as a config-driven plugin** — but bound to telephony, not WebSocket-direct from a mobile client. The plugin's value is the agent + memory + tools wiring; the transport (Twilio media streams) is not directly applicable.

### Multi-tenancy story (corrected from prior assessment)
- One Gateway can host many isolated agents. Each agent = one user-equivalent persona with separate workspace + auth + sessions.
- Audri's NestJS server holds the single Gateway operator token. Per-user requests get proxied with `model: "openclaw/<userAgentId>"` to route to the right agent.
- Per-user OAuth credentials live in `~/.openclaw/agents/<userAgentId>/agent/auth-profiles.json`. Connectors that need per-user OAuth (Gmail, Calendar) attach there.
- Cost per agent at idle: small (a few MB on disk; no continuous compute). Cost during active session: an embedded agent run (LLM cost + worker memory).
- The hard ceiling is unclear without empirical testing — how many concurrent agents in one Gateway before HTTP/process bottlenecks. Worth a load test before committing to the model. Multiple Gateways are also supported on one host with named profiles, so horizontal scale-out within a host is available.

---

## What was wrong in my prior assessments

I owe a calibration update before recommending anything. In the previous turn I made three claims that don't survive verification:

1. **"OpenClaw's memory model is just markdown notes."** Wrong. `memory-wiki` is a real wiki with claims/evidence/provenance/dashboards/search-modes. It's structurally comparable to ours and has design ideas we don't have yet (claim contradiction tracking, freshness staleness signals, intent-biased search modes that align directly with our Conversational Routing concept).

2. **"Multi-tenancy is a fleet-of-containers workaround."** Wrong. One Gateway hosts many agents natively. The trust boundary is the Gateway operator token, not a per-agent token, but Audri sits in front of that boundary anyway. Effectively this gives us a multi-tenant system with one shared OpenClaw process per region/cluster.

3. **"The connector ecosystem doesn't really exist."** Half right, half wrong. As *bundled plugins* it largely doesn't (no Gmail plugin in `extensions/`). As *standalone MIT-licensed CLIs in the org*, it does — and those CLIs are callable from anywhere, not just OpenClaw. That's the integration story: OpenClaw skills wrap the CLIs, but Audri can wrap them just as easily.

My structural concerns that **do** hold:
- Storage model is filesystem-per-agent. Native to Render+Supabase it is not.
- Native plugins run in-process; you can't safely host third-party user code there.
- The HTTP API has no per-user scoping; auth happens at Gateway level.
- Voice is hot-path-sensitive; OpenClaw runtime adds hops we don't currently have.
- The 369k-stars-in-5-months number is suspicious enough to caveat the "social proof" angle. The engineering is real; the popularity claim may be inflated. Don't pick OpenClaw because it's "popular."

---

## The integration question — three paths

Restating to ground the rest of the doc.

- **Path 1: Cherry-pick CLIs + patterns.** Keep Audri's stack. Lift the standalone connector CLIs (`gogcli`, `notcrawl`, `remindctl`, etc.) into our worker as `exec`-backed plugin handlers. Study `memory-wiki` claims/provenance design and `active-memory` blocking sub-agent pattern as references for our V1+ wiki and ingestion roadmap. No runtime dependency on OpenClaw.
- **Path 2: OpenClaw as backend, Audri as polished UX.** Replace Audri's Drizzle/Supabase wiki with OpenClaw's `memory-wiki`. Multi-tenancy via one shared Gateway, per-user agentIds. Audri's NestJS becomes a thin proxy + auth + UX layer. Keep Gemini Live voice direct to mobile (don't go through `voice-call` telephony plugin); route tool calls through OpenClaw's HTTP API.
- **Path 3: The murky middle.** Keep our wiki, also use OpenClaw runtime for some things, sync state both directions. **This is the worst option.** Two sources of truth. Two prompt-engineering models. Double the surface area to maintain. I list it only to dismiss it.

---

## Path 1 in detail (recommended)

**What you build:**
- Add a `connectors` plugin family to `apps/worker/src/registry/plugin-registry.ts`. Each connector handler shells out to a CLI binary (`gogcli`, `notcrawl`, `remindctl`, etc.) installed in the worker container.
- Per-user OAuth state: extend `auth/` to manage per-user OAuth flows (Google, Notion, etc.), store tokens in Postgres, project them into per-job env vars or temp keyring files when invoking a CLI.
- Schema additions: per-connector artifact tables (`gmail_threads`, `calendar_events`, `notion_pages` snapshots) following the same pattern as `research_outputs`.
- UI: per-connector settings flow in mobile (OAuth grant), wire artifact tables into existing `useResearchOutputs`-style hooks.

**What you study but don't take a runtime dependency on:**
- `memory-wiki`'s structured claims model — adopt for our wiki at V1+ (we already started this with `pro_fan_out_response`; their model is more developed).
- `memory-wiki`'s search modes (`find-person`, `route-question`, `source-evidence`, `raw-claim`) — these map onto our Conversational Routing postures. Lift the mode→ranking-bias pattern when we wire routing into retrieval.
- `active-memory` blocking sub-agent pattern — generalize our Flash retrieval into a config-driven blocking pre-reply pass. Their `queryMode` (`message`/`recent`/`full`) and `promptStyle` (`balanced`/`strict`/`recall-heavy`/`preference-only`) configurations are nice points to lift.
- Their `dreaming` Light/Deep/REM weighted-scoring promotion model — informs how we'd ever do background consolidation V2+.
- Their plugin manifest format + capability ownership model — useful reference when our `agent_tasks` plugin registry grows past `research`.

**Pros:**
- Keeps the architecture you already shipped to TestFlight. v0.1.1 prompt-engineering work and v0.1.0 schema both stand.
- Gets the connector capability you actually said you wanted — Gmail / Calendar / Notion / Reminders are real, MIT-licensed, callable today.
- Multi-tenancy stays on Supabase + RLS, which is built for SaaS scale.
- Voice path stays hot — Gemini Live direct to mobile, no extra hops.
- Reversible. If we decide later that `memory-wiki` is better than ours, we can migrate. If we don't, we owe nothing.
- Lifts the *good ideas* without the lock-in cost.

**Cons:**
- We still write the agent-side glue: prompts, plugin handlers, OAuth flows, error recovery. We get the heavy lifting (CLI implementations) but not the agent-loop wiring.
- We don't get the network effect of being on ClawHub/the OpenClaw plugin ecosystem.
- We don't get the credibility-by-association of "Audri is the polished frontend for OpenClaw."

**Cost estimate:** ~1–2 weeks per major connector (Gmail, Calendar, Notion) including OAuth + skill prompts + artifact schema + UI. Plus ~3–5 days to factor a `cli-exec` plugin handler base into the worker. Plus the memory-wiki/active-memory pattern study, which informs but doesn't block other work.

**Risk:** Low. The CLIs are independent of OpenClaw the runtime. If OpenClaw stalls or pivots, we still own our integrations.

---

## Path 2 in detail (alternative)

**What you build:**
- Replace Audri's wiki tables (`wiki_pages`, `wiki_sections`, junction tables) with OpenClaw's filesystem-backed `memory-wiki` vault — one vault per user agent.
- Run OpenClaw Gateway in our infra. Migrate from Render web service to a container platform that supports persistent volumes (Fly.io Machines, Kubernetes with PVCs, or Render's persistent disk if it scales). Per-user agent state mounted from durable storage.
- Audri's NestJS server becomes:
  - Auth + tenant manager (Supabase Auth → user_id → agentId mapping)
  - HTTP proxy: mobile → NestJS → OpenClaw `/v1/chat/completions` or `/tools/invoke` with `model: "openclaw/<agentId>"`
  - State projection: pull current wiki state from OpenClaw via `wiki_search`/`wiki_get` and project to a thin Postgres cache for RxDB sync. (OR drop RxDB entirely and have mobile go through a thin REST layer with caching.)
  - Conversational Routing: ported to OpenClaw skills + system prompts under the user's agent workspace.
- Voice path: keep Gemini Live direct from mobile (don't use telephony plugin). Tool calls during the call route through Audri server → OpenClaw `/tools/invoke`.

**Pros (if it works):**
- We inherit `memory-wiki`'s claims/contradictions/dashboards/search-modes for free.
- We inherit `active-memory` + `dreaming` for free — full memory pipeline without rebuilding.
- We get the connector ecosystem either via the standalone CLIs (which we'd use anyway in Path 1) or via OpenClaw skills wrapping them.
- We can advertise Audri as the polished UX over the OpenClaw stack — real positioning advantage.
- Plugin system is mature; we can extend behavior via plugin manifests + skill bundles instead of writing TypeScript handlers in our worker.

**Cons (substantial):**
- **Throws away all v0.1.0 + v0.1.1 schema and prompt-engineering work.** Conversational Routing, Bundle 1, on-demand profile sub-pages, claim-level audit, Flash→Pro fan-out — all rewritten against OpenClaw primitives. That's ~weeks-to-months of redo.
- **Filesystem state is a different infrastructure paradigm** than our Postgres+RxDB stack. Backups, migrations, DR, observability are all per-tenant filesystem operations rather than per-DB ops.
- **RxDB sync model breaks.** Current mobile gets reactive updates from Supabase replication. With OpenClaw-as-source-of-truth, mobile either polls REST or we build a custom sync that watches OpenClaw events and pushes to Supabase.
- **OpenClaw lock-in is real.** Their pace, priorities, breaking changes become ours. The 5-month-old codebase is moving fast (recent commits include `feat(plugin-sdk): add LLM completion API to plugin (#64294)` — that's substantial daily change).
- **The 369k-stars-in-5-months claim is suspicious.** I can't verify whether this is organic. If it's not, the project's resilience/longevity is harder to predict.
- **Native plugin trust model.** If we want users to add their own plugins, we can't safely host them in-process. Skills are safer but limited to markdown.
- **Voice integration is awkward.** Gemini Live still works direct from mobile, but tool calls during a live call need a low-latency path through OpenClaw. Their `realtime.fastContext.timeoutMs` is a recognition that this is hard. Latency budget will be tight.

**Cost estimate:** 4–8 weeks of focused engineering for the core pivot, plus ongoing operational overhead from running a container fleet. Plus an indeterminate amount of prompt-engineering rework to match our existing UX behaviors against OpenClaw's primitives. Plus migration: existing TestFlight users would need a data migration path from our schema to OpenClaw's vault format.

**Risk:** High. You're betting on OpenClaw's long-term stewardship, taking a major infra change, and rebuilding ~6 weeks of prompt-engineering work against new abstractions. Not worth doing unless you're confident the long-game payoff is worth it.

---

## Recommendation

**Path 1, pursued seriously.**

Three reasons:

1. **It captures the upside you actually named.** You said the appeal was "save engineering on connectors." Path 1 captures essentially all of that upside via the standalone CLIs, which are MIT-licensed and callable from our existing worker without any architectural change.

2. **It preserves optionality.** Path 1 doesn't preclude Path 2 later. If a year from now we decide OpenClaw's memory + agent loop are decisively better than what we've built, we can pivot then with a year of operational learning behind us. Path 2 first preserves no optionality back the other way — once mobile + auth + state are pointing at OpenClaw's primitives, undoing that is itself a multi-week project.

3. **It de-risks the two unknowns I can't resolve from docs alone.** First, the 369k-star plausibility — we'd want OpenClaw to demonstrate 12+ months of sustained activity before betting our backend on it. Second, the multi-tenant agent-density ceiling — how many agents per Gateway before performance degrades. Both questions need empirical answers, and Path 1 buys time to gather them without committing.

What Path 1 does **not** do that's worth flagging: it doesn't create the marketing positioning of "Audri is the polished UX for OpenClaw." If that positioning matters strategically (e.g., for fundraising or developer-credibility), there's a separate question of whether you can claim it without the runtime dependency. I think you can — you can publicly position Audri as "the consumer/mobile face of self-hostable agent stacks like OpenClaw" while keeping your own implementation.

---

## What to do this week if you accept Path 1

1. **Pilot one connector end-to-end** — pick `gogcli` for Gmail+Calendar. Build a worker plugin handler that wraps `gog gmail search --json` / `gog calendar events --today --json`. Define artifact tables. Wire it into the agent-task dispatcher. Build minimal mobile UI to display threads/events. Time-box: 1 week including OAuth UX.
2. **Audit `memory-wiki` claims model against our `pro_fan_out_response` work.** Specifically: their `claims[].evidence[]` shape, `confidence`, `status: "supported" | "contested" | "rejected"`, freshness `lastRefreshedAt`, contradiction reports. Decide which fields to lift into our schema as we evolve toward V1.
3. **Read `active-memory.md` once more with the eye toward Audri's preload + Flash retrieval.** Their `queryMode` (message/recent/full) and `promptStyle` configurations are nice points to lift. Generalize our Flash retrieval into a config-driven blocking pre-reply pass.
4. **Ship the `notcrawl` connector if Gmail goes well.** Same pattern.

Don't do (yet):
- Don't migrate the wiki schema to filesystem.
- Don't run an OpenClaw Gateway in our infra.
- Don't try to wire OpenClaw HTTP API into the voice hot path.

---

## Open questions for you

1. **Does the marketing positioning matter?** If "Audri is the polished UX for the OpenClaw stack" is strategically important (fundraising, developer credibility, distribution), Path 2 has a stronger pull than I credited. If it's just a thought ("they have what we want, let's lift it"), Path 1 is clearly stronger.

2. **What's the trust horizon for OpenClaw?** Are you comfortable betting a SaaS backend on a 5-month-old project regardless of star count? My personal lean is "not yet" — I'd want 12+ months of sustained governance, a clear funding/maintenance story, and a reasonable break-glass migration plan. If you've done the founder/maintainer due-diligence, that may be a non-issue.

3. **Is the connector ecosystem THE thing, or is it an example of a broader value prop?** If your real ask is "make Audri a polished UX over a well-maintained agent backend, with tons of connectors," Path 2 might be the right shape. If it's "save engineering specifically on Gmail/Calendar/Notion connectors," Path 1 nails it directly.

4. **How much of v0.1.1's prompt work do you consider sunk cost vs. genuinely valuable?** I won't take a position on this — you flagged sunk-cost risk in the prior session and you're right to. But practically: if the v0.1.1 work (Conversational Routing, Bundle 1, on-demand profile sub-pages, claim-level audit) feels like it's in the right shape and worth keeping, Path 1 lets you build forward from it. If it doesn't, Path 2's cost looks lower in relative terms.

5. **What's the multi-user load profile you're planning for?** Path 1 scales on Supabase. Path 2 scales on container density per Gateway. The economics flip somewhere — at 10 users one shared Gateway is trivial; at 100k it might be many Gateways. Without knowing the target curve, I can't pre-validate.

---

## Appendix: artifacts worth lifting from OpenClaw regardless of path

These are design ideas to study and adopt incrementally. None require runtime integration.

### From `memory-wiki`
- Structured `claims[]` with `id/text/status/confidence/evidence[]/updatedAt`. We have the seed of this in `pro_fan_out_response`; their model is more developed.
- `personCard` metadata for entity pages: handles, socials, emails, timezone, lane, ask-for, avoid-asking-for, confidence, privacy. This is exactly the profile/relationships use case as native primitives.
- `relationships[]` typed edges between pages with `kind/weight/confidence/evidenceKind`. Explicit relationship graph structure.
- Freshness/staleness via `lastRefreshedAt` separate from `updatedAt`. Good signal for the agent to know "this fact is supported but old."
- Search modes biased by intent (`find-person`, `route-question`, `source-evidence`, `raw-claim`). Direct fit for our Conversational Routing postures.
- Dashboards: `reports/contradictions.md`, `reports/stale-pages.md`, `reports/open-questions.md`, etc. Surfacing wiki-health issues to the user is something we don't do yet.

### From `active-memory`
- The blocking pre-reply sub-agent pattern. Generalize Audri's preload into a configurable blocking pass with `queryMode` (message/recent/full), `promptStyle` (strict/balanced/recall-heavy/preference-only), bounded `timeoutMs`, and circuit-breaker on consecutive timeouts.
- The `setupGraceTimeoutMs` pattern for cold-start situations (model warm-up + index load) — we don't have this yet and our first-call latency reflects it.

### From plugin SDK
- Capability ownership model — "one company plugin owns all of that company's surfaces." When we add Audri's second plugin (beyond `research`), this is a clean way to think about it.
- Hook decision semantics: `block: true` is terminal, `block: false` is no-op (not a clear). Good pattern for our agent-task pre-dispatch hooks if/when we add them.
- Per-hook timeouts overridable at config level. Useful for our worker if a particular plugin hook is slow.

### From dreaming
- Weighted scoring for promoting short-term observations to long-term: frequency / relevance / query-diversity / recency / consolidation / conceptual-richness. If we ever do background consolidation, this is a good starting weight set.
- Three-phase model (Light stage → REM reflect → Deep promote). Probably overkill for V1 but worth noting.

### Connectors (CLIs to study and possibly adopt as `exec` tools)
- `gogcli` — Google Suite (Gmail, Calendar, Drive, Contacts, Docs, Sheets, etc.) — primary target
- `notcrawl` — Notion → SQLite + markdown — secondary
- `remindctl` — Apple Reminders — quick win for iOS
- `imsg` — iMessage CLI for sending/receiving — could be relevant for Audri-as-a-text-channel later
- `wacli` — WhatsApp CLI — same
- `Peekaboo` — macOS screenshots + visual Q&A via MCP — interesting for desktop expansion
- `AXorcist` — macOS Accessibility — chainable UI control, advanced but interesting

### Patterns we already have or are close to
- Conversational Routing → their search modes. Map onto each other directly.
- Agent-scope persona model → their `SOUL.md` + `IDENTITY.md` + `USER.md` workspace files. Same shape, different file split.
- Wiki sections at h2 granularity → their `memory/YYYY-MM-DD.md` daily notes are a different model. Their wiki is page-level. We're closer to theirs than to raw daily-notes memory.
- Plugin handler registry → their capability + hook system. Ours is simpler; theirs has more types and more hooks.

---

## Sources read

The OpenClaw docs are checked out locally at `~/dev/openclaw-docs/docs/` — read directly with the Read tool to pull anything not covered here.

For traceability, this evaluation is grounded in the following docs (read in full or substantial part):

- `index.md`, `AGENTS.md`
- `concepts/architecture.md`, `concepts/agent.md`, `concepts/agent-loop.md`, `concepts/agent-workspace.md`
- `concepts/memory.md`, `concepts/memory-builtin.md`, `concepts/memory-search.md`, `concepts/memory-honcho.md`, `concepts/memory-qmd.md`, `concepts/active-memory.md`, `concepts/dreaming.md`
- `concepts/multi-agent.md`, `concepts/context-engine.md`, `concepts/oauth.md`, `concepts/openclaw-sdk.md`, `concepts/streaming.md`
- `plugins/memory-wiki.md`, `plugins/architecture.md`, `plugins/sdk-overview.md`, `plugins/sdk-runtime.md`, `plugins/hooks.md`, `plugins/plugin-inventory.md`, `plugins/voice-call.md`
- `gateway/openai-http-api.md`, `gateway/openresponses-http-api.md`, `gateway/tools-invoke-http-api.md`, `gateway/multiple-gateways.md`
- `tools/skills.md` (full)
- GitHub API: full repo list for `openclaw` org (54 repos), main repo metadata, top contributors, recent commits
- GitHub raw READMEs: `openclaw/gogcli`, `openclaw/clawhub`, `openclaw/notcrawl`
- ClawHub website (limited; SPA-rendered, partial scrape)

Docs **not** read (worth a follow-up pass if Path 2 becomes serious):
- `gateway/sandboxing.md`, `gateway/security/`, `gateway/secrets-plan-contract.md`
- `concepts/compaction.md`, `concepts/session.md`, `concepts/queue.md`, `concepts/system-prompt.md`
- `tools/skills-config.md`, `tools/creating-skills.md`, `tools/capability-cookbook.md` (too large for one read; needs paginated)
- `plugins/architecture-internals.md`, `plugins/sdk-channel-plugins.md`, `plugins/sdk-provider-plugins.md`
- ClawHub docs (`docs/clawhub.md` in the clawhub repo) — would clarify the moderation/security model

---

## TL;DR for future Claude

If you're picking this back up: the user wants Audri to keep its current Render+Supabase backend, lift the OpenClaw connector CLIs as MIT-licensed standalone tools wrapped by Audri's worker plugin registry (`gogcli` first), and study OpenClaw's `memory-wiki` claims model + `active-memory` blocking-sub-agent pattern as references for our V1+ wiki and ingestion roadmap. Don't pivot the architecture. Don't run an OpenClaw Gateway. Don't replace the wiki schema. Reassess in 12 months when OpenClaw's track record is longer.
