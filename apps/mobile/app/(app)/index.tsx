import {
  FontAwesome6,
  Ionicons,
  MaterialCommunityIcons,
} from "@expo/vector-icons";
import { Redirect, router, useFocusEffect } from "expo-router";
import { MessageCircle, NotebookTabs } from "lucide-react-native";
import { useCallback, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PluginTile } from "../../components/PluginTile";
import { CallButton } from "../../components/buttons";
import { firstNameFromUser, timeAwareGreeting } from "../../lib/greeting";
import { useRxdbReady } from "../../lib/rxdb/useRxdbReady";
import { supabase } from "../../lib/supabase";
import { useCallStore } from "../../lib/useCallStore";
import { useCallRecoverySweep } from "../../lib/useCallSweep";
import { useMe } from "../../lib/useMe";
import { usePluginOverlay } from "../../lib/usePluginOverlay";
import { useSession } from "../../lib/useSession";

export default function HomeScreen() {
  const session = useSession();
  const accessToken =
    session.status === "signed-in" ? session.session.access_token : null;
  const me = useMe(accessToken);

  const callStatus = useCallStore((s) => s.status);
  const showOverlay = usePluginOverlay((s) => s.show);

  // Compute exact tile width so 4 fit per row across all device sizes.
  // Percentage widths + columnGap caused 4×23% + 3×12px to overshoot the
  // inner width (3-per-row on real devices). Pixel math is exact.
  const { width: screenWidth } = useWindowDimensions();
  const GRID_PADDING = 24;
  const GRID_GAP = 20;
  const TILES_PER_ROW = 4;
  const tileWidth =
    (screenWidth - 2 * GRID_PADDING - (TILES_PER_ROW - 1) * GRID_GAP) /
    TILES_PER_ROW;

  // True when a call is alive somewhere in the background. Idle = no
  // active session. Anything else (connecting / connected / ending /
  // dropped) means the FAB should rejoin instead of starting fresh.
  const callActive = callStatus !== "idle";

  // The FAB visuals (icon + helper text) lag behind callActive on the
  // call-START path so the stack-nav animation finishes before the icon
  // swaps to PhoneForwarded — without this, returning to home from /call
  // shows the new icon already painted during the slide-in.
  // Call-END is synchronous: reset the moment callActive flips so the
  // home FAB shows the default icon BEFORE the slide-in begins, instead
  // of after it completes (which would read as a stale → fresh pop).
  const ICON_SWAP_DELAY = 350;
  const [displayCallActive, setDisplayCallActive] = useState(callActive);
  useFocusEffect(
    useCallback(() => {
      if (!callActive) {
        setDisplayCallActive(false);
        return;
      }
      const t = setTimeout(() => setDisplayCallActive(true), ICON_SWAP_DELAY);
      return () => clearTimeout(t);
    }, [callActive]),
  );

  // Boot RxDB sync on home so the wiki overlay has data ready when opened.
  useRxdbReady();

  // Recover any orphaned call from a previous session (force-quit, network
  // drop, backgrounded-but-failed-to-reach-server). Runs once per sign-in.
  useCallRecoverySweep();

  async function signOut() {
    await supabase.auth.signOut();
  }

  // Home no longer flips status to 'connecting'. call.tsx owns the
  // session lifecycle: on mount with status === 'idle' it kicks start();
  // on mount with any other status it just rejoins without re-starting.
  // Keeping status flips here would make the home FAB briefly read as
  // "Call in progress" during the route transition AND short-circuit
  // call.tsx's idle gate so the new session never gets opened.
  function openCall() {
    router.push("/call");
  }

  // First-run / loading gate (must come AFTER all hooks above to keep hook
  // order stable across renders). While /me is loading, render null so the
  // home UI doesn't flash before the onboarding redirect resolves — the root
  // LavaLamp shows through, giving a smooth auth → onboarding transition for
  // first-time users. Once /me is ready and onboarding is incomplete, redirect
  // synchronously via the Redirect component so home never paints. Errors
  // fall through to the home render so the user isn't stuck on a blank screen.
  if (me.status === "loading") return null;
  if (
    me.status === "ready" &&
    me.data.userSettings &&
    !me.data.userSettings.onboardingComplete
  ) {
    return <Redirect href="/(app)/onboarding" />;
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>Audri</Text>
          <Pressable onPress={signOut} style={styles.avatar}>
            <Ionicons name="person-outline" size={20} color="#e8f1ff" />
          </Pressable>
        </View>

        <View style={styles.grid}>
          <PluginTile
            label="Agents"
            icon={
              <MaterialCommunityIcons name="robot" size={36} color="#e8f1ff" />
            }
            widthPx={tileWidth}
            onPressWithOrigin={(origin) => showOverlay("agents", origin)}
          />
          <PluginTile
            label="Notes"
            icon={<NotebookTabs size={36} color="#e8f1ff" strokeWidth={1.5} />}
            widthPx={tileWidth}
            onPressWithOrigin={(origin) => showOverlay("wiki", origin)}
          />
          <PluginTile
            label="Chat History"
            icon={<MessageCircle size={36} color="#e8f1ff" strokeWidth={1.5} />}
            widthPx={tileWidth}
            onPressWithOrigin={(origin) => showOverlay("chatHistory", origin)}
          />
          <PluginTile
            label="Todos"
            icon={
              <Ionicons name="checkbox-outline" size={36} color="#e8f1ff" />
            }
            widthPx={tileWidth}
            onPressWithOrigin={(origin) => showOverlay("todos", origin)}
          />
          <PluginTile
            label="Research"
            icon={<Ionicons name="search-outline" size={36} color="#e8f1ff" />}
            widthPx={tileWidth}
            onPressWithOrigin={(origin) => showOverlay("research", origin)}
          />
          <PluginTile
            label="Automations"
            icon={<Ionicons name="flash-outline" size={36} color="#e8f1ff" />}
            widthPx={tileWidth}
            onPressWithOrigin={(origin) => showOverlay("automations", origin)}
          />
          <PluginTile
            label="Account"
            icon={
              <Ionicons
                name="person-circle-outline"
                size={36}
                color="#e8f1ff"
              />
            }
            widthPx={tileWidth}
            onPressWithOrigin={(origin) => showOverlay("account", origin)}
          />
        </View>

        <View style={styles.fabRow}>
          <CallButton
            mode="start"
            onPress={openCall}
            accessibilityLabel={
              displayCallActive ? "Return to call in progress" : "Start call"
            }
          >
            {displayCallActive ? (
              <FontAwesome6 name="arrow-right" size={28} color="#ffffff" />
            ) : undefined}
          </CallButton>
          {/* Always render the helper-text slot so the FAB above stays
              at the same y position whether or not the call is active.
              Placeholder space keeps the Text's line height occupied;
              opacity hides it when there's nothing to say. Uses the
              delayed displayCallActive so it visually swaps in sync
              with the icon, after the stack-nav animation completes. */}
          <Text
            style={[styles.fabSubtext, { opacity: displayCallActive ? 1 : 0 }]}
            numberOfLines={1}
          >
            {displayCallActive ? "Call in progress" : " "}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingTop: 8,
  },
  wordmark: {
    color: "#e8f1ff",
    fontSize: 24,
    fontFamily: "Comfortaa_400Regular",
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#11203a",
    alignItems: "center",
    justifyContent: "center",
  },
  greetingBlock: { marginTop: 48, paddingHorizontal: 24, gap: 8 },
  greeting: { color: "#e8f1ff", fontSize: 28, fontWeight: "500" },
  subtext: { color: "#7aa3d4", fontSize: 14 },
  errorText: { color: "#f87171", fontSize: 12 },
  grid: {
    marginTop: 40,
    paddingHorizontal: 24,
    flexDirection: "row",
    flexWrap: "wrap",
    // Tile widths are computed in JS from `useWindowDimensions` to ensure
    // 4-per-row exactly across devices; this stylesheet only owns the
    // surrounding gaps. Keep `rowGap` and `columnGap` in sync with the
    // `GRID_GAP` constant in the screen so the math stays right.
    rowGap: 20,
    columnGap: 20,
  },
  fabRow: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingBottom: 16,
    gap: 8,
  },
  fabSubtext: {
    color: "#7aa3d4",
    fontSize: 13,
    letterSpacing: 1,
  },
});
