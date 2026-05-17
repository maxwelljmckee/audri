// Text-chat screen. Parity with /call lifecycle (ChatProvider at root,
// mount-once start, leave-doesn't-end).
//
// Bubble rendering uses the shared TranscriptBubble (solid-pill
// styling), same component used by Call History detail view. The
// gradient-bubble treatment (MessengerGradientChat scaffold) is parked
// in the backlog — see backlog.md.
//
// Audri streams in token-by-token; the in-progress agent text gets
// appended as the last bubble in the list so it renders as a normal
// agent bubble. On stream-end the streaming buffer empties and the
// response lands in the transcript as a finalized agent turn.

import { Ionicons } from '@expo/vector-icons';
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
import { TranscriptBubble, transcriptBubbleStyles } from '../../components/TranscriptBubble';
import { TypingIndicator } from '../../components/TypingIndicator';
import { GlassButton } from '../../components/buttons';
import { useChatContext } from '../../lib/ChatContext';
import type { TranscriptTurn } from '../../lib/gemini/transcript';
import { useChatStore } from '../../lib/useChatStore';

const ENDING_DELAY_MS = 400;

const STREAMING_ID = 'streaming-agent';
interface DisplayTurn {
  id: string;
  role: 'user' | 'agent';
  text: string;
}
function buildDisplayTurns(
  transcript: TranscriptTurn[],
  streamingAgentText: string,
): DisplayTurn[] {
  const out: DisplayTurn[] = transcript.map((t) => ({
    id: t.id,
    role: t.role,
    text: t.text,
  }));
  const trimmed = streamingAgentText.trim();
  if (trimmed) {
    out.push({ id: STREAMING_ID, role: 'agent', text: trimmed });
  }
  return out;
}

export default function ChatScreen() {
  const status = useChatStore((s) => s.status);
  const endChat = useChatStore((s) => s.endChat);
  const reset = useChatStore((s) => s.reset);
  const startChat = useChatStore((s) => s.startChat);

  const { start, end, sendUserText, transcript, streamingAgentText, error } = useChatContext();

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);

  // Mount-once kick. Same idle-gate as /call so navigating back into
  // the screen mid-session rejoins without re-starting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once
  useEffect(() => {
    if (status !== 'idle') return;
    startChat();
    void start();
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

  // Auto-scroll to the latest content whenever the transcript, the
  // streaming buffer, or the draft-typing indicator changes. Small
  // timeout lets the ScrollView measure first; without it, scrollToEnd
  // lands one frame behind.
  const draftHasContent = draft.trim() !== '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps drive the scroll trigger; body doesn't read them
  useEffect(() => {
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 16);
    return () => clearTimeout(t);
  }, [transcript.length, streamingAgentText, draftHasContent]);

  const displayTurns = buildDisplayTurns(transcript, streamingAgentText);

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
            onPress={endChat}
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
            style={styles.flex}
            contentContainerStyle={[styles.scrollContent, transcriptBubbleStyles.list]}
          >
            {displayTurns.map((t) => (
              <TranscriptBubble key={t.id} role={t.role} text={t.text} />
            ))}
            {/* Right-aligned typing indicator while the user has draft
                text in the input — visual cue that the next bubble is
                being composed. Hides as soon as input is empty (clears
                on send too). */}
            {draft.trim() !== '' && <TypingIndicator side="user" />}
            {status === 'connecting' && displayTurns.length === 0 && (
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
  // Explicit width — GlassButton's content layout is absoluteFill, so the
  // Pressable has no intrinsic content sizing; consumer styles have to
  // provide dimensions. Width tuned to fit "End Chat" at the styled
  // font with comfortable breathing room. borderRadius = height/2 gives
  // a pill shape.
  endButton: {
    width: 100,
    height: 38,
    borderRadius: 19,
  },
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
