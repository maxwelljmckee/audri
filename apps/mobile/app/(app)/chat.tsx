// Text-modality chat screen. Parity with /call lifecycle (CallProvider at
// root, mount-once start, leave-doesn't-end). Renders the conversation as
// iMessage-style bubbles — user-side bubbles get a gradient fill via
// MaskedView (lifted from the facebook-messenger-gradient scaffold).
//
// Audri streams in token-by-token; the in-progress bubble at the bottom
// reads from useCall's streamingAgentText. On turnComplete the streaming
// buffer empties and lands in the transcript as a finalized turn.

import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GlassButton } from '../../components/buttons';
import { useCallContext } from '../../lib/CallContext';
import type { TranscriptTurn } from '../../lib/gemini/transcript';
import { useCallStore } from '../../lib/useCallStore';

const ENDING_DELAY_MS = 400;
const GRADIENT_COLORS = ['#FD84AA', '#A38CF9', '#09E0FF'] as const;
const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);
const { height: SCREEN_HEIGHT } = Dimensions.get('window');

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
  const [contentHeight, setContentHeight] = useState(0);
  const scrollRef = useRef<Animated.ScrollView>(null);
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

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

  // Translate the gradient by the scroll offset so it appears fixed in
  // the viewport while bubbles scroll past — each user bubble lights up
  // with its viewport-relative slice of the gradient (parallax).
  const gradientStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: scrollY.value }],
  }));

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
          <Animated.ScrollView
            ref={scrollRef}
            onScroll={onScroll}
            scrollEventThrottle={16}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Wrap mask + visible-text in the same container so both share
                identical flex layout — the mask drives parent height, the
                overlay sits on top via absolute fill. */}
            <View onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)}>
              <MaskedView
                style={styles.maskedHost}
                maskElement={
                  <View>
                    {visibleMessages.map((m) => (
                      <View
                        key={`mask-${m.id}`}
                        style={[
                          styles.bubble,
                          m.role === 'user' ? styles.bubbleMine : styles.bubbleAgent,
                          {
                            backgroundColor: m.role === 'user' ? '#fff' : 'transparent',
                          },
                        ]}
                      >
                        <Text style={styles.bubbleHiddenText}>{m.text}</Text>
                      </View>
                    ))}
                  </View>
                }
              >
                {/* Gradient sized to screen height + translated by scroll
                    so it appears fixed in viewport. contentHeight here just
                    ensures the masked region matches the bubble stack. */}
                <View style={{ height: Math.max(contentHeight, SCREEN_HEIGHT) }}>
                  <AnimatedLinearGradient
                    colors={GRADIENT_COLORS}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[styles.gradient, gradientStyle]}
                  />
                </View>
              </MaskedView>

              {/* Visible-text overlay. Same flex layout as the mask, so
                  bubble positions line up; absolute fill so it overlays
                  the gradient. User bubbles render transparent (gradient
                  shows through the mask beneath); agent bubbles paint a
                  flat dark surface where the mask was transparent. */}
              <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
                {visibleMessages.map((m) => (
                  <View
                    key={`text-${m.id}`}
                    style={[
                      styles.bubble,
                      m.role === 'user' ? styles.bubbleMine : styles.bubbleAgent,
                      {
                        backgroundColor: m.role === 'user' ? 'transparent' : '#1f2937',
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.bubbleText,
                        m.role === 'user' ? styles.bubbleTextMine : styles.bubbleTextAgent,
                      ]}
                    >
                      {m.text}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {status === 'connecting' && visibleMessages.length === 0 && (
              <Text style={styles.statusHint}>Connecting…</Text>
            )}
          </Animated.ScrollView>

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
  maskedHost: {
    flex: 1,
  },
  gradient: {
    flex: 1,
  },
  bubble: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginVertical: 4,
    borderRadius: 18,
    maxWidth: '78%',
  },
  bubbleMine: {
    alignSelf: 'flex-end',
    borderBottomRightRadius: 6,
  },
  bubbleAgent: {
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 6,
  },
  bubbleText: {
    fontSize: 16,
    lineHeight: 22,
  },
  bubbleTextMine: { color: '#ffffff' },
  bubbleTextAgent: { color: '#e8f1ff' },
  // The mask-layer text is invisible — we only need its bounds so the
  // bubble silhouette sizes match the visible-text layer above. Using
  // transparent (rather than opacity:0) keeps the alpha mask itself
  // opaque for the bubble silhouette.
  bubbleHiddenText: { fontSize: 16, lineHeight: 22, color: 'transparent' },
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
