// Single conversation turn — used by both the live chat screen
// (apps/(app)/chat.tsx) and the Call History detail view
// (components/chatHistory/ChatHistoryNavigation.tsx) so the visual is
// consistent across surfaces.
//
// Solid-color pills, no gradient masking. The gradient-bubble treatment
// (see components/animations/facebook-messenger-gradient-conversation/)
// is parked in the backlog until the masking pattern can be refined to
// look right on short conversations.

import { StyleSheet, Text, View } from 'react-native';

export type TranscriptRole = 'user' | 'agent';

export interface TranscriptBubbleProps {
  role: TranscriptRole;
  text: string;
}

export function TranscriptBubble({ role, text }: TranscriptBubbleProps) {
  const isUser = role === 'user';
  return (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAgent]}>
        <Text style={[styles.text, isUser ? styles.textUser : styles.textAgent]}>{text}</Text>
      </View>
    </View>
  );
}

export const transcriptBubbleStyles = StyleSheet.create({
  // List gap when rendering a stack of bubbles. Exported so the
  // wrapping container can match the per-row spacing.
  list: { gap: 8 },
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
  },
  bubbleUser: { backgroundColor: '#3a5a8d' },
  bubbleAgent: { backgroundColor: '#11203a' },
  text: { fontSize: 14, lineHeight: 20 },
  textUser: { color: '#e8f1ff' },
  textAgent: { color: '#cdd9eb' },
});
