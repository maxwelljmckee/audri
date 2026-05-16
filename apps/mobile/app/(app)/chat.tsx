// Text-modality chat screen. Parity with /call lifecycle (CallProvider at
// root, mount-once start, leave-doesn't-end). Renders the conversation as
// iMessage-style bubbles — user bubbles get a per-bubble pink→purple→cyan
// gradient via expo-linear-gradient.
//
// Audri streams in token-by-token; the in-progress bubble at the bottom
// reads from useCall's streamingAgentText. On stream-end the streaming
// buffer empties and the response lands in the transcript as a
// finalized agent turn.

import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlassButton } from '../../components/buttons';
import { useCallContext } from '../../lib/CallContext';
import type { TranscriptTurn } from '../../lib/gemini/transcript';
import { useCallStore } from '../../lib/useCallStore';

const ENDING_DELAY_MS = 400;
const GRADIENT_COLORS = ['#FD84AA', '#A38CF9', '#09E0FF'] as const;

interface VisibleMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  streaming?: boolean;
}

const STREAMING_ID = 'streaming-agent';
function buildVisibleMessages(
  transcript: TranscriptTurn[],
  streamingAgentText: string,
): VisibleMessage[] {
  const out: VisibleMessage[] = transcript.map((t) => ({
    id: t.id,
    role: t.role,
    text: t.text,
  }));
  const trimmed = streamingAgentText.trim();
  if (trimmed) {
    out.push({ id: STREAMING_ID, role: 'agent', text: trimmed, streaming: true });
  }
  return out;
}

export default function ChatScreen() {
  const status = useCallStore((s) => s.status);
  const endCall = useCallStore((s) => s.endCall);
  const reset = useCallStore((s) => s.reset);
  const startCall = useCallStore((s) => s.startCall);

  const { start, end, sendUserText, transcript, streamingAgentText, error } = useCallContext();

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  // Mount-once kick — text modality. Same idle-gate as /call so navigating
  // back into the screen mid-session rejoins without re-starting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once
  useEffect(() => {
    if (status !== 'idle') return;
    startCall();
    void start({ modality: 'text' });
  }, []);

  // Hang-up flow: ending → tear down + return home.
  useEffect(() => {
    if (status !== 'ending') return;
    let cancelled = false;
    void end().then((ok) => {
      if (cancelled) return;
      if (!ok) return;
      setTimeout(() => {
        reset();
        router.back();
      }, ENDING_DELAY_MS);
    });
    return () => {
      cancelled = true;
    };
  }, [status, end, reset]);

  // Auto-scroll to the latest content whenever the transcript or the
  // streaming buffer grows. Small timeout lets the ScrollView measure
  // first; without it, scrollToEnd lands one frame behind.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive the scroll trigger; body doesn't read them
  useEffect(() => {
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 16);
    return () => clearTimeout(t);
  }, [transcript.length, streamingAgentText]);

  const visibleMessages = buildVisibleMessages(transcript, streamingAgentText);

  function handleSend() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    sendUserText(text);
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
        <View style={styles.header}>
          <GlassButton
            onPress={() => router.back()}
            style={styles.headerButton}
            accessibilityLabel="Back to home"
          >
            <Ionicons name="chevron-back" size={22} color="#e8f1ff" />
          </GlassButton>
          <GlassButton
            onPress={endCall}
            disabled={status !== 'connected'}
            tintColor="#f43f5e"
            style={styles.endButton}
            accessibilityLabel="End chat"
          >
            <Text style={styles.endButtonText}>End Chat</Text>
          </GlassButton>
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.flex}
          keyboardVerticalOffset={0}
        >
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {visibleMessages.map((m) =>
              m.role === 'user' ? (
                <View
                  key={m.id}
                  style={[styles.bubble, styles.bubbleMine, styles.bubbleUserGradientHost]}
                >
                  {/* Per-bubble gradient. Each user bubble renders the
                      full pink→purple→cyan ramp behind its text — close
                      visual cousin of the iMessage gradient, simpler than
                      the masked-view parallax. */}
                  <LinearGradient
                    colors={GRADIENT_COLORS}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={StyleSheet.absoluteFill}
                  />
                  <Text style={[styles.bubbleText, styles.bubbleTextMine]}>{m.text}</Text>
                </View>
              ) : (
                <View
                  key={m.id}
                  style={[styles.bubble, styles.bubbleAgent, styles.bubbleAgentSolid]}
                >
                  <Text style={[styles.bubbleText, styles.bubbleTextAgent]}>{m.text}</Text>
                </View>
              ),
            )}
            {status === 'connecting' && visibleMessages.length === 0 && (
              <Text style={styles.statusHint}>Connecting…</Text>
            )}
          </ScrollView>

          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Message Audri"
              placeholderTextColor="#5b7397"
              multiline
              style={styles.input}
              returnKeyType="send"
              onSubmitEditing={handleSend}
              blurOnSubmit={false}
              editable={status === 'connected'}
            />
            <Pressable
              onPress={handleSend}
              disabled={status !== 'connected' || !draft.trim()}
              style={({ pressed }) => [
                styles.sendButton,
                {
                  opacity: status !== 'connected' || !draft.trim() ? 0.4 : pressed ? 0.7 : 1,
                },
              ]}
              accessibilityLabel="Send message"
            >
              <Ionicons name="arrow-up" size={20} color="#ffffff" />
            </Pressable>
          </View>
        </KeyboardAvoidingView>

        {error && (
          <Text style={styles.errorText} numberOfLines={2}>
            {error.startsWith('SPEND_CAP_EXCEEDED')
              ? 'Monthly spending limit reached. Raise the limit in Account → Usage to start a new chat.'
              : error}
          </Text>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'rgba(12, 19, 32, 0.85)' },
  safe: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerButton: { width: 40, height: 40, borderRadius: 20 },
  endButton: { height: 40, paddingHorizontal: 14, borderRadius: 20 },
  endButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  bubble: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginVertical: 4,
    borderRadius: 18,
    maxWidth: '78%',
    overflow: 'hidden',
  },
  bubbleMine: {
    alignSelf: 'flex-end',
    borderBottomRightRadius: 6,
  },
  bubbleAgent: {
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 6,
  },
  bubbleUserGradientHost: {
    // The gradient is positioned absolutely inside the bubble; overflow
    // hidden (above) clips it to the rounded corners.
  },
  bubbleAgentSolid: {
    backgroundColor: '#1f2937',
  },
  bubbleText: {
    fontSize: 16,
    lineHeight: 22,
  },
  bubbleTextMine: { color: '#ffffff' },
  bubbleTextAgent: { color: '#e8f1ff' },
  statusHint: {
    color: '#7aa3d4',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 24,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: '#11203a',
    color: '#e8f1ff',
    fontSize: 16,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    color: '#f87171',
    fontSize: 12,
    paddingHorizontal: 24,
    paddingBottom: 8,
    textAlign: 'center',
  },
});
