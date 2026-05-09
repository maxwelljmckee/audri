import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CallEndedDropped } from '../../components/CallEndedDropped';
import { Orb } from '../../components/Orb';
import { CallButton, GlassButton } from '../../components/buttons';
import { useCallContext } from '../../lib/CallContext';
import { useCallStore } from '../../lib/useCallStore';
import { useMe } from '../../lib/useMe';
import { useSession } from '../../lib/useSession';

const ENDING_DELAY_MS = 400;

function formatElapsed(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export default function CallScreen() {
  const status = useCallStore((s) => s.status);
  const endCall = useCallStore((s) => s.endCall);
  const reset = useCallStore((s) => s.reset);
  const startCall = useCallStore((s) => s.startCall);
  // startedAt is set by useCall.start when /calls/start succeeds; read
  // from the store so the elapsed timer reads the SAME baseline across
  // mount/unmount (back button → home → rejoin).
  const startedAt = useCallStore((s) => s.startedAt);

  // Read from the hoisted CallProvider so the live session survives this
  // screen unmounting (in-call back button → home → re-enter call).
  const { start, end, error } = useCallContext();

  // Elapsed seconds, computed from `startedAt` rather than a counter so
  // the value is correct on remount instead of restarting at 0.
  const [elapsed, setElapsed] = useState(0);

  // Resolve the active agent's name to display below the timer. Picks
  // the agent flagged as default (server flags one at signup); falls
  // back to the first agent in the list if none is marked. Renders
  // nothing when /me hasn't loaded yet, so the layout is stable when
  // the data arrives.
  const session = useSession();
  const accessToken = session.status === 'signed-in' ? session.session.access_token : null;
  const me = useMe(accessToken);
  const agentName =
    me.status === 'ready'
      ? (me.data.agents.find((a) => a.isDefault)?.name ?? me.data.agents[0]?.name ?? null)
      : null;

  // Kick the live call only when this screen mounts on top of an idle
  // session. If the session is already connecting/connected (the user
  // navigated home and tapped back to /call to rejoin), don't re-start.
  // Intentionally only fire once on mount in the idle case. Subsequent
  // status changes (connecting → connected → ending) MUST NOT re-trigger
  // start(); we only care about the initial idle → kick transition.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once kick; status changes intentionally don't re-trigger start
  useEffect(() => {
    if (status !== 'idle') return;
    startCall(); // store: idle → connecting; useCall onOpen will mark connected
    void start();
  }, []);

  // Elapsed timer while connected. Recompute each tick from the stored
  // startedAt so navigating away and back picks up the real elapsed
  // time instead of restarting at 0.
  useEffect(() => {
    if (status !== 'connected' || !startedAt) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [status, startedAt]);

  // Hang-up: ending → tear down + return home. If end() returns false the
  // /calls/:id/end post failed and end() has already flipped the store to
  // 'dropped' — DON'T auto-route home; the dropped-call screen will render
  // and the user gets retry/dismiss control. The launch sweep will retry
  // recovery on next app start.
  useEffect(() => {
    if (status !== 'ending') return;
    let cancelled = false;
    void end().then((ok) => {
      if (cancelled) return;
      if (!ok) return;
      setTimeout(() => {
        reset();
        setElapsed(0);
        router.back();
      }, ENDING_DELAY_MS);
    });
    return () => {
      cancelled = true;
    };
  }, [status, end, reset]);

  if (status === 'dropped') {
    return (
      <CallEndedDropped
        reason={error ?? undefined}
        onRetry={() => {
          setElapsed(0);
          startCall();
          void start();
        }}
        onDismiss={() => {
          reset();
          setElapsed(0);
          router.back();
        }}
      />
    );
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
        {/* Back button — returns to home WITHOUT ending the call. The
            session lives in CallProvider at app root, so the call keeps
            running until the user explicitly hangs up. The home FAB
            switches to a "rejoin" affordance while a call is active. */}
        <View style={styles.topBar}>
          <GlassButton
            onPress={() => router.back()}
            style={styles.backButton}
            accessibilityLabel="Back to home"
          >
            <Ionicons name="chevron-back" size={22} color="#e8f1ff" />
          </GlassButton>
        </View>
        <View style={styles.center}>
          <View style={styles.statusBlock}>
            {/* Always render the agent-name slot, even before /me resolves,
                so the layout doesn't shift when the name lands. The space
                placeholder keeps the Text's line height occupied; opacity
                hides it until the real name is ready. */}
            <Text style={[styles.agentName, { opacity: agentName ? 1 : 0 }]} numberOfLines={1}>
              {agentName ?? ' '}
            </Text>
            <Text style={styles.timer}>
              {status === 'connecting' || status === 'idle'
                ? 'Connecting…'
                : formatElapsed(elapsed)}
            </Text>
          </View>
          <Orb />
        </View>

        {/* fabRow matches home's structure (button + helper text below
            with the same gap), so the end-call button lands at the
            exact same y-position as the home/onboarding start button. */}
        <View style={styles.fabRow}>
          <CallButton mode="end" onPress={endCall} disabled={status !== 'connected'} />
          <Text style={styles.fabSubtext}>Tap to end</Text>
        </View>

        {error && (
          <Text style={styles.errorText} numberOfLines={2}>
            {error}
          </Text>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'rgba(12, 19, 32, 0.8)' },
  // paddingBottom: 16 matches home + onboarding so the end-call button
  // lands at the exact same y-position as the start-call FAB across
  // all three screens.
  safeArea: { flex: 1, paddingBottom: 16 },
  topBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  backButton: { width: 40, height: 40, borderRadius: 20 },
  // Mirrors home's fabRow exactly (alignItems:center + gap:8) so the
  // end-call button + helper text occupy the same vertical footprint as
  // the start-call FAB across screens.
  fabRow: { alignItems: 'center', gap: 8 },
  fabSubtext: { color: '#7aa3d4', fontSize: 13, letterSpacing: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28 },
  // Tight stack: agent name on top (the emphasized line), timer beneath
  // (de-emphasized). Small gap so they read as a single status pair.
  statusBlock: { alignItems: 'center', gap: 4 },
  agentName: { color: '#e8f1ff', fontSize: 40, fontWeight: '600' },
  timer: { color: '#7aa3d4', fontSize: 32, fontWeight: '500' },
  errorText: {
    color: '#f87171',
    fontSize: 12,
    marginTop: 8,
    paddingHorizontal: 24,
    textAlign: 'center',
  },
});
