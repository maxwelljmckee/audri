import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CallEndedDropped } from '../../components/CallEndedDropped';
import { Orb } from '../../components/Orb';
import { useCall } from '../../lib/gemini/useCall';
import { useCallStore } from '../../lib/useCallStore';

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

  const { start, end, error } = useCall();
  const startedRef = useRef(false);

  const [elapsed, setElapsed] = useState(0);

  // Kick the live call exactly once when this screen mounts.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startCall(); // store: idle → connecting; useCall onOpen will mark connected
    void start();
  }, [start, startCall]);

  // Elapsed timer while connected.
  useEffect(() => {
    if (status !== 'connected') return;
    const i = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(i);
  }, [status]);

  // Hang-up: ending → tear down + return home.
  useEffect(() => {
    if (status !== 'ending') return;
    let cancelled = false;
    void end().then(() => {
      if (cancelled) return;
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
          startedRef.current = false;
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
        <View style={styles.center}>
          <Text style={styles.timer}>
            {status === 'connecting' || status === 'idle' ? 'Connecting…' : formatElapsed(elapsed)}
          </Text>
          <Orb />
        </View>

        <Pressable
          onPress={endCall}
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
  safeArea: { flex: 1, alignItems: 'center', paddingBottom: 48 },
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
  errorText: { color: '#f87171', fontSize: 12, marginTop: 8, paddingHorizontal: 24, textAlign: 'center' },
});
