# Audri — Backlog Archive

Closed items relocated from `backlog.md` so the active doc stays focused on prospective future work. Newest-first within each section. Cross-search works via `grep -r <term> .claude/architecture/`.

When a backlog item ships / folds into another doc / promotes into a build-phase, cut its row from `backlog.md` and paste here under the appropriate section with the closing date prepended. Keep the original entry text in the Notes column so context isn't lost.

---

## Shipped

| Name | Closed | Shipped in | Notes |
|---|---|---|---|
| **Project-scoped todos (architecture decision needed)** | 2026-05-10 | v0.2.0 cycle (documented v0.4.0) | Resolved with a generalization: instead of project-specific scoping, the `todos` sidecar carries a nullable `parent_page_id` FK to ANY wiki page. Project todo → parent_page_id is the project. Goal todo → parent_page_id is `profile/goals`. Person-related todo → person's wiki page. NULL → "General" lane. Status moved off the wiki hierarchy entirely (option (b) status-as-column) — the four `todos/<status>` bucket pages were tombstoned. UX is two-axis: horizontal status tabs (To do / In progress / Done / Archived) × vertical collapsible swimlanes (General + per-page associations). Live agent prompt + Pro fan-out prompt updated to suggest/confirm associations conservatively (default NULL; mention isn't directive). Sidecar referential integrity beats `project_slug` strings for handling page renames automatically. |
| **Homescreen plugin tile icons: darken** | 2026-05-11 | v0.2.0 | Plugin tile icons on the home screen rendered too light against the BlurView background. Resolution: bumped icon color from muted blue (`#7aa3d4`) to off-white (`#e8f1ff`) to match the auth provider buttons + home avatar — *raised* contrast rather than darkening; same outcome. Captured in `build-phases/v0.2.0.md` → Visual polish pass. Source: post-MVP UX request 2026-05-10. |
| **Rename "Wiki" → "Notes" in UI** | 2026-05-10 | v0.2.0 cycle | All user-facing references to "Wiki" now read "Notes" — UI strings (PluginTile label, PluginOverlay title, search placeholder, sync state, empty state, pending banner) and live-agent prompt prose (system-prompt.ts `composeGenericScaffolding` "Notes structure" header + the onboarding scaffolding's Transparency principle, plus preload.ts "Notes structure" + "Recently active notes" headers). Live-agent prompts include explicit "always say notes — never wiki" reminders. Internal code identifiers stayed `wiki` (per the original spec). Captured in memory `feedback_user_facing_terminology` for future Claude consistency. Source: post-MVP UX request 2026-05-06. |
| **Failed-ingestion retry button (UI)** | 2026-05-10 | v0.2.0 (DEC-B) | Subsumed by the Notes pending banner's failed-state CTA. When any `call_transcripts.ingestion_status='failed'` rows exist for the user, the banner renders a red error chrome with a "Retry" button that hits `POST /calls/:id/retry-ingest` (parallelized for multiple failures). Same endpoint, surfaced in the right user-facing context (Notes overlay header). Also accessible per-chat from the Chat History plugin's detail view. |
| **Plugin overlays = apps with own router + stack navigation** | 2026-04-28 | MVP (post-research-validation) | Each plugin overlay (Wiki, Research) now mounts its own `<NavigationContainer>` + `<NativeStackNavigator>` inside the scale-from-tile PluginOverlay shell. Real push/pop semantics, native slide-in/out animations, back gesture. Helpers in `components/PluginStack.tsx` (`createPluginStack<T>()`, `PluginNavigationContainer`, `PluginBackRow`, `pluginStackScreenOptions`); per-plugin screens in `components/wiki/WikiNavigation.tsx` + `components/research/ResearchNavigation.tsx`. Architectural P0 — sets the pattern for all subsequent overlays. Source: post-research-validation review. |
| **EAS Build configuration + TestFlight pipeline** | 2026-04-29 | MVP | Apple Developer enrollment approved; `apps/mobile/eas.json` created with development / preview / production profiles; `eas credentials` configured; first TestFlight build live via `eas build --platform ios --profile preview`; `eas submit` wired for app-store delivery. Originally P0 blocked on Apple support per memory `project_apple_dev_blocking_scope.md`. |
| **MVP cleanup: Slice 6.5 resilience flow validation** | 2026-04-29 | MVP | Verified on device. |
| **MVP cleanup: Sentry smoke test (all 3 projects)** | 2026-04-29 | MVP | Verified (server, worker via organic capture, mobile). |
| **MVP cleanup: EAS Build + TestFlight** | 2026-04-29 | MVP | First build live (`com.talktoaudri.audri` 0.1.0). |

---

## Folded into spec / build-phase

| Name | Closed | Folded into | Notes |
|---|---|---|---|
| **Voice-driven wiki mutations (move existing pages)** | 2026-05-06 | v0.1.1 | Hierarchy move shipped. Tombstone + rename remain as separate V1 follow-ups — see "Voice-driven wiki mutations cluster — tombstone + rename" entry in active backlog. |
| **Conversational modes (fluid mode-shifting)** | 2026-05-05 | `specs/conversational-routing.md` | Brainstorm and Dictation are now persona cells (Co-Creator + Note Taker) in the larger Conversational Routing framework. Tracked under v0.1.1 as the Conversational Routing implementation pass. |
| **Explicit UX core principles in scaffolding** | 2026-05-05 | `specs/conversational-routing.md` | Foundational layer underneath the persona system. The four principles (Proactiveness / Transparency / Continuity / Autonomy) are honored by every persona; spec describes how each persona expresses each principle. Tracked under v0.1.1 as part of the Conversational Routing implementation pass. |
| **Generic-call scaffolding clause: Expectation Setting / Control / Autonomy** | 2026-05-05 | `specs/conversational-routing.md` | The "ask when intent is ambiguous" instruction is the Autonomy principle's expression in the routing framework's foundational layer, and is the explicit fallback when the model can't classify intent. Tracked under v0.1.1 as part of the Conversational Routing implementation pass. |

---

## Promoted to build-phase

| Name | Closed | Promoted to | Notes |
|---|---|---|---|
| **Hard spending-cap enforcement** | 2026-05-12 | `build-phases/v0.3.0.md` | Backend-focused, composes naturally with v0.2.1's Usage substrate — moved out of backlog into v0.3.0 alongside the installable-plugins theme. See v0.3.0.md for the full design points. |
