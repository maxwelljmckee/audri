import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Orb } from '../../components/Orb';
import { useCall } from '../../lib/gemini/useCall';
import { useCallStore } from '../../lib/useCallStore';

const ENDING_DELAY_MS = 400;

// First-run experience. User sees a "Tap to begin" prompt; tapping starts the
// onboarding call. Server flips user_settings.onboarding_complete on /end so
// subsequent app loads route to home instead of back here.
export default function OnboardingScreen() {
  const status = useCallStore((s) => s.status);
  const startCall = useCallStore((s) => s.startCall);
  const endCall = useCallStore((s) => s.endCall);
  const reset = useCallStore((s) => s.reset);

  const { start, end, error } = useCall();
  const [phase, setPhase] = useState<'pre' | 'live' | 'finishing'>('pre');
  const finishingRef = useRef(false);

  const begin = useCallback(() => {
    setPhase('live');
    startCall();
    void start({ callType: 'onboarding' });
  }, [start, startCall]);

  const skip = useCallback(() => {
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
          <View style={styles.heroBlock}>
            <Text style={styles.welcome}>Welcome to Audri.</Text>
            <Text style={styles.body}>
              Let's get to know each other. I'll ask you a few things — about your goals,
              your work, what you're into. It's a conversation, not a form. Skip anything
              you don't want to talk about.
            </Text>
            <Text style={styles.bodyMuted}>Takes about ten minutes.</Text>
          </View>

          <View style={styles.actionBlock}>
            <Pressable onPress={begin} style={styles.beginButton}>
              <Ionicons name="call-outline" size={22} color="#fff" />
              <Text style={styles.beginLabel}>Tap to begin</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                reset();
                router.replace('/(app)');
              }}
              style={styles.skipButton}
              hitSlop={12}
            >
              <Text style={styles.skipLabel}>Skip for now</Text>
            </Pressable>
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

        <Pressable
          onPress={skip}
          disabled={status !== 'connected'}
          style={[styles.hangup, { opacity: status === 'connected' ? 1 : 0.5 }]}
        >
          <Ionicons
            name="call"
            size={26}
            color="#fff"
            style={{ transform: [{ rotate: '135deg' }] }}
          />
        </Pressable>

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
  root: { flex: 1, backgroundColor: '#0a1628' },
  safeArea: { flex: 1, alignItems: 'center', paddingBottom: 48, paddingHorizontal: 24 },
  heroBlock: { flex: 1, justifyContent: 'center', gap: 16 },
  welcome: { color: '#e8f1ff', fontSize: 32, fontWeight: '600' },
  body: { color: '#cbd9eb', fontSize: 16, lineHeight: 24 },
  bodyMuted: { color: '#7aa3d4', fontSize: 14 },
  actionBlock: { alignItems: 'center', gap: 16 },
  beginButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#4d8fdb',
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: 32,
  },
  beginLabel: { color: '#fff', fontSize: 17, fontWeight: '600' },
  skipButton: { paddingVertical: 8 },
  skipLabel: { color: '#7aa3d4', fontSize: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28 },
  timer: { color: '#e4e4e7', fontSize: 32, fontWeight: '600' },
  hangup: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ef4444',
  },
  errorText: {
    color: '#f87171',
    fontSize: 12,
    marginTop: 8,
    paddingHorizontal: 24,
    textAlign: 'center',
  },
});
