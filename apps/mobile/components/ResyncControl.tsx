// Pull-to-refresh control with consistent cross-platform styling.
//
// `tintColor` is iOS-only (colors the UIRefreshControl spinner). Android
// uses `colors` (an array of hex strings) for the spinner. Setting both
// keeps the visual identity consistent on either platform.
// `progressBackgroundColor` colors the Android track behind the spinner —
// kept to a near-bg azure so the control doesn't paint a bright disc on
// the dark surface.
//
// Pull-to-refresh control with consistent cross-platform styling.
//
// `tintColor` is iOS-only (colors the UIRefreshControl spinner). Android
// uses `colors` (an array). Setting both keeps the visual identity
// consistent on either platform.
//
// **Known issue 2026-05-10:** on iOS in this stack (RN 0.81 + Expo 54
// + independent NavigationContainer + BlurView ancestor), the spinner
// renders as the system default (near-black on the dark surface) and
// ignores `tintColor` regardless of how it's set — prop, style, title/
// titleColor, setNativeProps, force-remount, all tried, all dropped.
// A control test (`<ActivityIndicator color>` in the same tree) renders
// correctly, confirming this is a RefreshControl-specific bridge bug,
// not a parent-cascade issue. Tracked in `backlog.md` → UX surface →
// "iOS RefreshControl tintColor"; revisit when RN/Expo bumps.
//
// Android side honors `colors` correctly.

import { RefreshControl } from 'react-native';

const SPINNER = '#60a5fa'; // bright sky blue (Android only — iOS ignores)
const TRACK_BG = '#11203a'; // Android-only; same surface used for tile fills

interface Props {
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
}

export function ResyncControl({ refreshing, onRefresh }: Props) {
  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={SPINNER}
      colors={[SPINNER]}
      progressBackgroundColor={TRACK_BG}
    />
  );
}
