import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CallButton } from '../../components/buttons';
import { Orb } from '../../components/Orb';
import { useCallContext } from '../../lib/CallContext';
import { useCallStore } from '../../lib/useCallStore';

const ENDING_DELAY_MS = 400;

// Pre-call guidance staggers in over a slow reveal. Three lines of
// instructional text fade in at STAGGER_MS intervals, then "Tap to Start"
// appears at the end. First-run users who already know what to do tap
// before any of it shows.
const STAGGER_MS = 2000;
const FADE_MS = 600;
const GUIDANCE_LINES = [
  'Turn up phone volume',
  'and find a quiet place',
  'to take your onboarding call',
];

// First-run experience. User sees a centered call button on the global
// lava lamp surface; tapping starts the onboarding call. After a few
// seconds of inaction a "Tap to Start" hint fades in. Server flips
// user_settings.onboarding_complete on /end so subsequent app loads route
// to home instead of back here.
export default function OnboardingScreen() {
  const status = useCallStore((s) => s.status);
  const startCall = useCallStore((s) => s.startCall);
  const endCall = useCallStore((s) => s.endCall);
  const reset = useCallStore((s) => s.reset);

  const { start, end, error } = useCallContext();
  const [phase, setPhase] = useState<'pre' | 'live' | 'finishing'>('pre');
  const finishingRef = useRef(false);

  // Staggered fade-in for the three guidance lines + the "Tap to Start"
  // hint. Each appears STAGGER_MS after the previous; the hint waits one
  // STAGGER beat after the last line. Anything not yet visible stays at
  // opacity 0 until its turn. If the user taps before the sequence
  // completes the live phase mounts and the pre block (with all these
  // animations) unmounts.
  const line0 = useSharedValue(0);
  const line1 = useSharedValue(0);
  const line2 = useSharedValue(0);
  const hintOpacity = useSharedValue(0);
  useEffect(() => {
    if (phase !== 'pre') return;
    const fade = (delayMultiplier: number) =>
      withDelay(STAGGER_MS * delayMultiplier, withTiming(1, {
        duration: FADE_MS,
        easing: Easing.out(Easing.cubic),
      }));
    line0.value = fade(1);
    line1.value = fade(2);
    line2.value = fade(3);
    hintOpacity.value = fade(4);
  }, [phase, line0, line1, line2, hintOpacity]);
  const line0Style = useAnimatedStyle(() => ({ opacity: line0.value }));
  const line1Style = useAnimatedStyle(() => ({ opacity: line1.value }));
  const line2Style = useAnimatedStyle(() => ({ opacity: line2.value }));
  const hintStyle = useAnimatedStyle(() => ({ opacity: hintOpacity.value }));

  const begin = useCallback(() => {
    setPhase('live');
    startCall();
    void start({ callType: 'onboarding' });
  }, [start, startCall]);

  // Hangs up the active onboarding call. The CallButton that uses this
  // is disabled until status === 'connected', so the not-connected
  // branch is defensive only — no remaining UI path reaches it now that
  // the pre-phase Skip link is gone.
  const hangUp = useCallback(() => {
    if (status === 'connected') endCall();
    else {
      reset();
      router.replace('/(app)');
    }
  }, [status, endCall, reset]);

  // When call enters 'ending' state (user tapped skip / hung up), tear down +
  // route home. The server flips onboarding_complete during /end.
  useEffect(() => {
    if (status !== 'ending' || finishingRef.current) return;
    finishingRef.current = true;
    setPhase('finishing');
    void end().then(() => {
      setTimeout(() => {
        reset();
        router.replace('/(app)');
      }, ENDING_DELAY_MS);
    });
  }, [status, end, reset]);

  if (phase === 'pre') {
    return (
      <View style={styles.root}>
        <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
          {/* Onboarding is mandatory at v0.1.1 — there's no "skip" path
              because the home screen redirects right back here whenever
              user_settings.onboarding_complete is false, which would loop.
              A real skip needs a server-side "mark onboarding complete
              without a transcript" path; deferred until that lands. */}
          <View style={styles.middleBlock}>
            <View style={styles.guidanceBlock}>
              <Animated.Text style={[styles.guidance, line0Style]}>
                {GUIDANCE_LINES[0]}
              </Animated.Text>
              <Animated.Text style={[styles.guidance, line1Style]}>
                {GUIDANCE_LINES[1]}
              </Animated.Text>
              <Animated.Text style={[styles.guidance, line2Style]}>
                {GUIDANCE_LINES[2]}
              </Animated.Text>
            </View>
          </View>

          <View style={styles.fabRow}>
            <CallButton mode="start" onPress={begin} accessibilityLabel="Start onboarding call" />
            {/* Hint below the button, matching the home FAB layout. The
                Animated.Text always renders (just with opacity 0 until
                its scheduled fade-in) so the button position is locked
                regardless of when the hint becomes visible. */}
            <Animated.Text style={[styles.hint, hintStyle]}>Tap to Start</Animated.Text>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'bottom']} style={styles.safeArea}>
        <View style={styles.center}>
          <Text style={styles.timer}>
            {status === 'connecting' || status === 'idle'
              ? 'Connecting…'
              : phase === 'finishing'
                ? 'Wrapping up…'
                : 'Listening'}
          </Text>
          <Orb />
        </View>

        <CallButton
          mode="end"
          onPress={hangUp}
          disabled={status !== 'connected'}
          style={styles.liveCallButton}
        />

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
  root: { flex: 1 },
  // Match home: paddingBottom 16 so the CallButton in fabRow lands at
  // the exact same spot during the onboarding → home transition.
  safeArea: { flex: 1, paddingBottom: 16, paddingHorizontal: 24 },
  // Mirrors home's fabRow exactly so the call button is in identical
  // screen position. Hint stacks just above the button via gap. No flex
  // here — the middleBlock above takes the remaining space, so this row
  // sits at the bottom by virtue of being the last child.
  fabRow: {
    alignItems: 'center',
    gap: 16,
  },
  // Fills the space above fabRow; centers the guidance vertically +
  // horizontally within that band.
  middleBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guidanceBlock: {
    alignItems: 'center',
    gap: 4,
  },
  guidance: {
    color: '#cbd9eb',
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  hint: {
    color: '#7aa3d4',
    fontSize: 14,
    letterSpacing: 1,
  },
  // Live-phase styles (Connecting / Listening / Wrapping up).
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28 },
  // safeArea no longer aligns children center; explicit on the end button.
  liveCallButton: { alignSelf: 'center' },
  timer: { color: '#e4e4e7', fontSize: 32, fontWeight: '600' },
  errorText: {
    color: '#f87171',
    fontSize: 12,
    marginTop: 8,
    paddingHorizontal: 24,
    textAlign: 'center',
  },
});
