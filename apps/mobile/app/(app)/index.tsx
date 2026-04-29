import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { PluginTile } from "../../components/PluginTile";
import { useCallStore } from "../../lib/useCallStore";
import { firstNameFromUser, timeAwareGreeting } from "../../lib/greeting";
import { useRxdbReady } from "../../lib/rxdb/useRxdbReady";
import { supabase } from "../../lib/supabase";
import { Sentry } from "../../lib/sentry";
import { useCallRecoverySweep } from "../../lib/useCallSweep";
import { useMe } from "../../lib/useMe";
import { usePluginOverlay } from "../../lib/usePluginOverlay";
import { useSession } from "../../lib/useSession";

export default function HomeScreen() {
  const session = useSession();
  const accessToken =
    session.status === "signed-in" ? session.session.access_token : null;
  const me = useMe(accessToken);
  const sessionUser =
    session.status === "signed-in" ? session.session.user : null;

  const greeting = timeAwareGreeting();
  const firstName = firstNameFromUser(sessionUser);

  const startCall = useCallStore((s) => s.startCall);
  const showOverlay = usePluginOverlay((s) => s.show);

  // Boot RxDB sync on home so the wiki overlay has data ready when opened.
  useRxdbReady();

  // Recover any orphaned call from a previous session (force-quit, network
  // drop, backgrounded-but-failed-to-reach-server). Runs once per sign-in.
  useCallRecoverySweep();

  // First-run redirect: if the user hasn't completed onboarding, send them to
  // the onboarding screen. Once onboarding_complete flips, every subsequent
  // load lands here normally.
  useEffect(() => {
    if (me.status !== "ready") return;
    if (me.data.userSettings && !me.data.userSettings.onboardingComplete) {
      router.replace("/(app)/onboarding");
    }
  }, [me]);

  async function signOut() {
    await supabase.auth.signOut();
  }

  // Dev-only smoke test for the mobile Sentry wiring. Long-press the avatar
  // to fire a deliberate exception that should land in the audri-mobile
  // Sentry project. Stripped from production builds via the __DEV__ guard
  // (Metro replaces __DEV__ with `false` in release bundles, dead-code-
  // eliminating the handler).
  function maybeSentrySmokeTest() {
    if (!__DEV__) return;
    Sentry.captureMessage("Sentry mobile smoke test (manual)", "info");
    throw new Error("Sentry mobile smoke test — intentional throw");
  }

  function openCall() {
    startCall();
    router.push("/call");
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>Audri</Text>
          <Pressable
            onPress={signOut}
            onLongPress={maybeSentrySmokeTest}
            style={styles.avatar}
          >
            <Ionicons name="person-outline" size={20} color="#e8f1ff" />
          </Pressable>
        </View>

        <View style={styles.greetingBlock}>
          {/* <Text style={styles.greeting}>
            {greeting}
            {firstName ? `, ${firstName}` : ''}.
          </Text> */}
          {me.status === "ready" && (
            <Text style={styles.subtext}>
              {me.data.agents.length} agent ·{" "}
              {me.data.userSettings?.enabledPlugins.length ?? 0} plugin
              {(me.data.userSettings?.enabledPlugins.length ?? 0) === 1
                ? ""
                : "s"}
            </Text>
          )}
          {me.status === "error" && (
            <Text style={styles.errorText}>/me error: {me.error}</Text>
          )}
        </View>

        <View style={styles.grid}>
          <PluginTile
            label="Wiki"
            icon="library-outline"
            onPressWithOrigin={(origin) => showOverlay("wiki", origin)}
          />
          <PluginTile
            label="Todos"
            icon="checkbox-outline"
            onPressWithOrigin={(origin) => showOverlay("todos", origin)}
          />
          <PluginTile
            label="Research"
            icon="search-outline"
            onPressWithOrigin={(origin) => showOverlay("research", origin)}
          />
          <PluginTile
            label="Profile"
            icon="person-circle-outline"
            onPressWithOrigin={(origin) => showOverlay("profile", origin)}
          />
        </View>

        <View style={styles.fabRow}>
          <Pressable onPress={openCall} style={styles.fab}>
            <Ionicons name="call-outline" size={28} color="#fff" />
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0a1628" },
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
    fontFamily: "Sniglet_400Regular",
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
    gap: 12,
  },
  fabRow: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingBottom: 16,
  },
  fab: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#4d8fdb",
    alignItems: "center",
    justifyContent: "center",
  },
});
