# SPEC — Mobile app (MVP)

Status: **draft** — design rules locked. Implementation happens alongside backend at code time.

This spec covers the React Native + Expo mobile app's MVP architecture: project structure, theming, routing, screens, reusable component primitives, and per-screen design notes.

---

## Project location + stack

- **Path:** `apps/mobile/` — alongside `apps/server` (NestJS API) and `apps/worker` (Graphile runner). Sandbox at `sandbox/conversational-ai/` is throwaway POC reference, not source for production patterns.
- **Framework:** React Native + Expo (managed)
- **Routing:** Expo Router (file-based)
- **Styling:** NativeWind (Tailwind-style classes for RN); themes defined as tokens from day one
- **State:** Zustand for client state (active call session, navigation transients, ephemeral UI state)
- **Synced data:** RxDB wrapping SQLite via `expo-sqlite`, with the Supabase replication plugin for realtime two-way sync
- **Voice:** Gemini Live for the in-call agent
- **Audio:** React Native Audio API for mic streaming, playback, processing
- **Auth:** Supabase Auth — **Apple + Google sign-in only at MVP**; no email/password
- **Icons:** Lucide RN + `@expo/vector-icons` (already validated in sandbox)
- **Haptics:** `expo-haptics`
- **Glass effects:** `expo-glass-effect` (already validated)

---

## Design language

The visual direction is **Liquid Glass** per the muse-home-v2 design exploration — voice-first, calm, dark-mode-default, ambient gradient backgrounds with translucent layered tiles.

### Themes

All five Liquid Glass variants (Azure / Aurora / Ember / Verdigris / Void) tokened from day one. **Default: Azure** — deep blue gradient, calm voice-first feel.

User-selectable theme switcher + light-mode variants are **V1+** (in `backlog.md`).

### Theme tokens (NativeWind config)

Tokens drive every color reference — no raw hex values in components. Categories:

- `background` (gradient stops) — outer screen background
- `surface` — translucent tile / card layer
- `surface-elevated` — call button, prominent buttons
- `text-primary` — headline, prominent body
- `text-secondary` — supporting text
- `text-muted` — small caps, captions
- `accent` — primary action color (mic button glow, etc.)
- `tile-accent-{1..4}` — per-tile accent backgrounds for plugin grid
- `divider`, `border`, `overlay`

Both the dark variant set + light variant set defined; light-mode tokens compile but no UI surface to switch yet.

### Full-screen, edge-to-edge content

- **Safe areas respected for layout positioning** (no content placed under the notch / time strip / home indicator).
- **Backgrounds always extend edge-to-edge** — no solid-color block under the safe area. The ambient gradient runs from screen-top to screen-bottom regardless of safe area; only padded content lives within safe-area inset.
- Use `react-native-safe-area-context`'s `useSafeAreaInsets()` for positioning; never wrap entire screens in `<SafeAreaView>` with a solid background that clips the gradient.

### Status bar

Per-screen content tint — light icons on dark backgrounds (most screens), dark icons if any future light-mode/light-background screens land. Configured via Expo's `<StatusBar>` component per screen, or set at the layout level. Defaults to `style="light"` at the root layout.

---

## Routing structure

Expo Router file-based. Layout:

```
apps/mobile/
└── app/
    ├── _layout.tsx              # root layout — providers (theme, RxDB, Zustand stores), status-bar default
    ├── (auth)/
    │   ├── _layout.tsx          # gates: redirect to (app)/ if authed
    │   └── sign-in.tsx          # Apple + Google buttons
    ├── (app)/
    │   ├── _layout.tsx          # gates: redirect to (auth)/sign-in if unauthed
    │   ├── index.tsx            # Home screen
    │   ├── onboarding.tsx       # Onboarding-mode call session
    │   └── call.tsx             # Standard call session
    └── +not-found.tsx
```

### Routing gates

- **Unauthed user → `/(auth)/sign-in`.** Authed users hitting `(auth)/*` redirect to home.
- **`user_settings.onboarding_complete = false` → home is still accessible** (per §10 amendment). User isn't trapped in onboarding. Subsequent call sessions surface a "want to finish onboarding?" offer at session start.
- **Active call session in Zustand:** Call screen mounts to render the session; if the user navigates away (rare), session keeps running at the root level. Re-entering `/(app)/call` re-mounts the UI against the existing session.

---

## Screens

### 1. Auth screen (`(auth)/sign-in.tsx`)

**Purpose:** authenticate via Apple or Google.

**Layout:**
- Full-screen ambient gradient (Azure default) behind everything
- Centered: small `muse.ai` wordmark
- Below wordmark: brief tagline (e.g., *"Voice-first knowledge OS"* — exact copy TBD at design time)
- Stack of two buttons: Apple sign-in, Google sign-in
- Footer: minimal terms-of-service / privacy-policy links

**Behavior:**
- Tap Apple → native Apple sign-in flow → Supabase Auth → if first signup, server runs seed transaction → redirect home (or onboarding if user navigates there)
- Tap Google → same flow with Google provider
- Loading spinner replaces buttons during auth callback

**Status bar:** light content.

### 2. Onboarding screen (`(app)/onboarding.tsx`)

**Purpose:** the user's first conversation. Establishes voice-first ethos from second one.

**Layout:**
- Full-screen ambient gradient (Azure default)
- Centered above the call button: short copy
  - *"Tap to start"* (primary)
  - Optional secondary: *"Let's get to know each other"* (smaller, muted)
- Centered call button: glass-effect circle with mic icon
- (No header, no plugin grid, no avatar — intentionally minimal)

**Behavior:**
- Tap call button → routes to `(app)/call.tsx` with `call_type='onboarding'`
- Onboarding screen itself doesn't host the call session — it's a launchpad. After call ends, redirect to home.

**Implementation note:** the onboarding screen is just a styled launcher. The call session itself is rendered by the Call screen with a `call_type` query param. Same `<CallSession>` component, different mode flag.

### 3. Home screen (`(app)/index.tsx`)

**Purpose:** primary surface; entry point to everything.

**Layout** (per muse-home-v2):
- Full-screen ambient gradient (theme-tokened)
- Top row (within safe area): `muse.ai` wordmark left, avatar circle right (stub at MVP — see backlog)
- Large greeting: *"Good morning."* (time-aware: morning / afternoon / evening) — H1, `text-primary`, generous line-height
- *No subtext* (sessions/drafts omitted per user direction)
- `PLUGINS` section header (small caps, `text-muted`)
- Plugin tile grid — see below
- Bottom: glass phone-icon button (no rounded-rectangle frame, no "Hold to Talk" copy)

**Plugin tile grid (MVP set):**
- 4 tiles: **Wiki, Todos, Research, Profile**
- Layout: 2 columns × 2 rows OR 4 in a single row depending on visual balance (decision at implementation; lean 2×2 with generous spacing)
- Tile size scales with screen width
- Each tile: rounded square, theme-tokened tile-accent background, icon centered (Lucide), label below
- Tap → `<PluginOverlay>` springs open from tile origin (origin-aware animation)
- New plugins added as they're built (V1+ adds Research siblings: Podcasts, Email, Calendar, Briefs)

**Bottom call button:**
- Glass-effect circle, `accent` background, mic / phone icon
- Tap → routes to `(app)/call.tsx` with `call_type='generic'`
- No frame around it — sits directly on the gradient
- Always visible at the bottom safe area (`insets.bottom + spacing`)

**Behavior:**
- Avatar tap → stubbed at MVP (backlog item: account / settings menu)
- Plugin tile taps → overlay animation
- Phone button tap → call screen

**Status bar:** light content.

### 4. Call screen (`(app)/call.tsx`)

**Purpose:** the active conversation surface — for both `generic` and `onboarding` calls.

**Style: modeled after iOS Phone app.** Simple, dark, ambient. Not a forest of UI.

**Layout:**
- Full-screen dark background (deeper than home — call mode is its own ambient state; can be the theme's deepest background token)
- Centered: **speaking orb** (animated; see below)
- Below orb: subtle text — agent name (or `Muse` default), subtle "in conversation" indicator, optional elapsed time
- Bottom: hang-up button (red circle, X or end-call icon)
- (No transcript feed at MVP. Voice is primary; reading the transcript while talking is anti-pattern. Transcript visible post-call via call-history surface, V1+.)

**Speaking orb:**
- Single animated organic shape (sphere / blob / softly-pulsating gradient)
- **Color shifts by speaker:**
  - User speaking → `accent-user` token (e.g., warm cyan-ish hue)
  - Agent speaking → `accent-agent` token (e.g., violet hue)
  - Idle / both quiet → muted neutral state
- **Audio-responsive animation:** amplitude of the active speaker drives the orb's scale / blur / glow intensity. Implementation via `react-native-reanimated` shared values fed from the audio API's level samples.
- Ambient idle motion (gentle breathing) when no one is speaking, so it never looks frozen.

**States the screen handles:**
- **Connecting** — orb in muted state with subtle pulse + caption "Connecting…"
- **Active conversation** — orb responsive, color-shifted by who's speaking
- **User has muted** (V1+ if mic-mute UI lands) — distinct visual state
- **Network dropped / disconnected** — orb fades to muted state; centered message: *"Call dropped"* + green phone-icon button labeled or implied "Tap to retry." Tapping reconnects the session.
- **Ending** — brief "Wrapping up…" state while end-call fires + transcript posts; auto-dismisses to home.

**Behavior:**
- Mounts with active session from Zustand. If no session, kicks off a fresh one based on the route's `call_type` param.
- Hang-up → `POST /calls/:session_id/end` → redirect to home (or last context if non-home)
- Network drop → automatic retry attempt; if fails, show "Call dropped" state with retry CTA
- Background audio session keeps the call alive through screen-lock (already validated in sandbox; reuse the audio-session config)

**Status bar:** light content, possibly hidden during call for full immersion (decision at implementation).

---

## Reusable component primitives

All in `apps/mobile/src/components/`. Built from theme tokens. No raw colors or screen-specific magic numbers.

### `<ScreenScaffold>`
- Wraps every screen. Accepts `gradient: 'home' | 'call' | 'onboarding' | 'auth'` prop selecting which background gradient to render.
- Renders gradient edge-to-edge; safe-area insets exposed via render-prop or a child-rendered context for content positioning.
- Sets status-bar style.

### `<ThemedView>`, `<ThemedText>`
- Token-aware atomic components. Most screens use NativeWind classes directly via tokens, but these primitives exist for cases where dynamic style logic is needed.
- `<ThemedText>` accepts `variant: 'h1' | 'h2' | 'body' | 'caption' | 'small-caps'` mapping to typography scale.

### `<PluginTile>`
- Single tile in the home plugin grid.
- Props: `{ id, label, icon, onPress, accentTone?: 1 | 2 | 3 | 4 }`
- Self-measures origin for the overlay animation (forwards a ref).

### `<PluginOverlay>` + `usePluginOverlay()`
- Origin-aware spring animation pattern, reimplemented cleanly.
- Hook returns `{ launch(Screen, originRef), close, overlay, animValue }`.
- Rebuilt component owns animation orchestration; Screen components implement standard `PluginScreenProps` interface (`{ onClose }`).

### `<TalkButton>`
- Glass phone-icon button at the bottom of Home.
- Tap → `router.push('/call')`.
- No rounded-rectangle frame; just the circle.

### `<CallSession>`
- The actual call experience UI (orb + states + hang-up). Mounts the Gemini Live session via the Gemini hook.
- Used by `(app)/call.tsx`. Onboarding's screen is a separate launcher (per §2 above) that routes INTO the call screen, so `<CallSession>` only mounts in one place.
- Props: `{ callType: 'generic' | 'onboarding', contextPageId?: string }`.

### `<Orb>`
- The speaking-orb animation. Subscribed to audio-level shared values + `speakerState: 'idle' | 'user' | 'agent'`.
- Reanimated-based.
- Self-contained — `<CallSession>` drops it in and feeds it state.

### `<CallEndedDropped>`
- Inline state component for the network-drop case. "Call dropped" copy + green phone retry button.

### `<AvatarStub>`
- Top-right circle on Home. MVP: just initial letter or generic icon, taps do nothing (V1+ opens account menu — backlog).

---

## State management

### Zustand stores

- `useAuthStore` — `{ user, session, signIn, signOut }` — mirrors Supabase Auth state.
- `useCallStore` — active call session — `{ status, callType, sessionId, transcript, speakerState, audioLevels, start, end, retry }`. Lives at root so navigating away from call screen doesn't tear it down.
- `useThemeStore` — current theme variant (Azure default; switching V1+).
- `useUIStore` — ephemeral UI state (modal visibility, etc.)

### RxDB

- Wraps `expo-sqlite`-backed local store
- Collections mirror server tables that should sync to client: `wiki_pages`, `wiki_sections`, `wiki_section_history` (read-only), `agents` (sanitized — no `persona_prompt`), `agent_tasks`, `research_outputs`, `usage_events` (V1+ for cost UI), `tags`, `wiki_page_tags`, `user_settings`, `call_transcripts`, `wiki_log`
- Supabase replication plugin handles two-way sync per RLS

---

## Time-aware greeting

Home's "Good morning." headline is time-of-day aware. Three buckets keyed off the user's local time:
- Morning (5am–12pm): "Good morning."
- Afternoon (12pm–6pm): "Good afternoon."
- Evening (6pm–5am): "Good evening."

Pulls user's timezone from `user_settings` (or device default if not set). Computed at component mount; doesn't update mid-session.

---

## Animations

Reanimated-based throughout. Key animations:

- **Plugin tile → overlay spring** (origin-aware, implemented in `<PluginOverlay>`)
- **Orb breathing** (idle state)
- **Orb speaker-driven scale + glow** (active states)
- **Speaker color cross-fade** (when speaker changes)
- **Call screen entry/exit** (slide-up from bottom on enter; fade-out on hang-up)
- **Auth → home transition** (fade)
- **Onboarding launch** — gentle scale-up of call button on press

All animations should respect reduced-motion preferences (`useReducedMotion()` from Reanimated) — fallback to fades where motion would be jarring.

---

## Backlog items spawned by this spec

(Already in `backlog.md` or to-be-added)

- Theme switcher + light-mode toggle (V1+)
- Avatar tap → account / settings menu (V1+)
- Mic-mute UI on call screen (V1+)
- In-call transcript feed (V1+ — most users won't want it; available behind a setting)
- Per-screen status-bar hiding for full immersion (V1+ polish)
- Custom voice selector (V1+ alongside custom agents)
- "Add plugin" tile / plugin marketplace surface (V1++)

---

## Related decisions

- `architecture.md` — overall system architecture; client section to be updated alongside this spec
- `todos.md` §8 — call session architecture (server side)
- `todos.md` §10 — onboarding interview design
- `todos.md` §20 — auth methods (Apple + Google locked here)
- `specs/onboarding.md` — onboarding interview spec; this mobile spec is the UI half of that flow
- `tradeoffs.md` — entries for Apple/Google-only auth, Liquid Glass theme system, etc. to land at code time

---

## Open / deferred for code-time decisions

- Exact tile-grid layout (2×2 vs. 1×4) at home — pick at implementation against actual screen sizes
- Specific Lucide icon choices per plugin tile
- Onboarding copy variants ("Tap to start" vs. alternatives) — final wording at code time
- Greeting copy style + punctuation
- Hang-up button exact treatment (iOS-Phone-red vs. theme-accented)
- Auth tagline copy
