import { Comfortaa_400Regular, useFonts } from "@expo-google-fonts/comfortaa";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LavaLamp } from "../components/animations/lava-lamp-background-animation";
import { ProfileOverlay } from "../components/ProfileOverlay";
import { ResearchOverlay } from "../components/ResearchOverlay";
import { SplashAnimation } from "../components/SplashAnimation";
import { TodosOverlay } from "../components/TodosOverlay";
import { WikiOverlay } from "../components/WikiOverlay";
import { Sentry, initSentry } from "../lib/sentry";
import "../global.css";

// Lava lamp blob set — blob color is a brighter step within the same
// blue family as the azure bg (rgb 10/22/40), so the blobs read as
// luminous patches rather than a distinct accent color. Try the options
// below in order from subtlest → most visible. Locked at module scope so
// the LavaLamp's `colors` memo doesn't churn across re-renders.
// LAVA_BG = the azure used everywhere else in the app (splash, plugin
// overlays, call screen). The BlurView with tint='dark' desaturates +
// darkens the surface, so the perceived post-blur color is slightly
// muddier than the input — the matching surfaces are pre-desaturated to
// match what the eye reads off the lava lamp.
const LAVA_BG = "#0a1628"; // rgb(10, 22, 40) — azure-bg

// In-family steps (same blue hue, brighter than bg). Deltas roughly
// +10 / +20 / +30 / +40 above bg in the dominant blue channel.
// const LAVA_BLOB = "rgba(20, 40, 75, 0.5)"; // azure +1 — barely perceptible
// const LAVA_BLOB = "rgba(25, 48, 85, 0.5)"; // azure +1 — barely perceptible
// const LAVA_BLOB = "rgba(30, 55, 95, 0.5)"; // azure +2 — gentle luminous patches
const LAVA_BLOB = "rgba(45, 75, 120, 0.5)"; // azure +3 — visible, still in-family

const LAVA_COLORS = [LAVA_BLOB, LAVA_BLOB, LAVA_BLOB];
const INTENSITY = 100;

// Init Sentry as early as possible at module load so any error during the
// React render path is captured. DSN-gated so local dev w/o EXPO_PUBLIC_SENTRY_DSN
// is a quiet no-op.
initSentry();

// Hold the native splash visible until our JS-side <SplashAnimation /> is
// mounted and ready to paint — otherwise the native splash hides on Expo's
// default timing and we'd see a frame of empty black before the wordmark
// appears. We hide it manually below once fonts are loaded.
SplashScreen.preventAutoHideAsync().catch(() => {
  // ignore — can fail in fast-refresh / hot-reload paths
});

function RootLayout() {
  // Load Comfortaa for the Audri wordmark. useFonts gates render until the
  // typeface is ready so we never see a fallback-flash. Reference in styles
  // via fontFamily: 'Comfortaa_400Regular'.
  const [fontsLoaded] = useFonts({ Comfortaa_400Regular });

  // Once fonts are ready, hide the native splash. The JS-side SplashAnimation
  // is mounted below and will paint immediately on first frame, so the
  // handoff is seamless (both surfaces are black with the wordmark).
  useEffect(() => {
    if (!fontsLoaded) return;
    SplashScreen.hideAsync().catch(() => {
      // ignore — already hidden, fast-refresh, etc.
    });
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    // App-wide animated lava lamp background. Sits at the absolute bottom
    // of the render tree; auth + onboarding + home use transparent screen
    // backgrounds so it shows through, plugin overlays use a translucent
    // azure surface so it shows through faintly. Stack contentStyle is
    // transparent so route transitions don't paint over it.
    <View style={styles.root}>
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        <LavaLamp
          count={3}
          colors={LAVA_COLORS}
          bgColor={LAVA_BG}
          duration={20000}
          intensity={INTENSITY}
          tint="dark"
        />
      </View>
      <SafeAreaProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: "transparent" },
          }}
        >
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(app)" />
        </Stack>
        <StatusBar style="light" />
        {/* Plugin overlays mount at app root so navigation away (e.g., to /call)
            doesn't tear them down. Each handles its own visibility via the
            plugin-overlay store. */}
        <WikiOverlay />
        <ResearchOverlay />
        <ProfileOverlay />
        <TodosOverlay />
        {/* Launch animation — mounted last so it sits above all overlays. Plays
            once per cold start, then unmounts itself. */}
        <SplashAnimation />
      </SafeAreaProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

// Wraps the root with Sentry's error boundary so render-path exceptions get
// captured along with component-stack info. Shows the default fallback (a
// blank screen) on crash; we'll polish this later if it ever fires in prod.
export default Sentry.wrap(RootLayout);
