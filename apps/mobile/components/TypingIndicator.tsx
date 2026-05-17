// Three-dot typing indicator. Renders in the same bubble visual as
// TranscriptBubble (color-matched to the role) so it slots into a
// message list as if it were a partial bubble.
//
// Used on the chat screen: shown on the user side whenever the input
// box has draft text, so the conversation reads as "you're composing
// the next message" even before sending.

import { MotiView } from 'moti';
import { StyleSheet, View } from 'react-native';
import type { TranscriptRole } from './TranscriptBubble';

export interface TypingIndicatorProps {
  /** Which side of the conversation the indicator belongs to.
   *  Determines bubble color + horizontal alignment. Named `side`
   *  rather than `role` to dodge biome's useValidAriaRole rule, which
   *  treats any `role` prop as an ARIA attribute. */
  side: TranscriptRole;
}

const DOT_COLOR_USER = '#e8f1ff';
const DOT_COLOR_AGENT = '#cdd9eb';
const BUBBLE_BG_USER = '#3a5a8d';
const BUBBLE_BG_AGENT = '#11203a';
// Staggered animation timing — each dot pulses, offset from the next
// by STAGGER_MS so the row reads as a left-to-right wave.
const STAGGER_MS = 150;
const PULSE_DURATION = 600;

export function TypingIndicator({ side }: TypingIndicatorProps) {
  const isUser = side === 'user';
  const dotColor = isUser ? DOT_COLOR_USER : DOT_COLOR_AGENT;
  const bubbleBg = isUser ? BUBBLE_BG_USER : BUBBLE_BG_AGENT;
  return (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, { backgroundColor: bubbleBg }]}>
        {[0, 1, 2].map((i) => (
          <PulsingDot key={i} color={dotColor} delay={i * STAGGER_MS} />
        ))}
      </View>
    </View>
  );
}

function PulsingDot({ color, delay }: { color: string; delay: number }) {
  return (
    <MotiView
      from={{ opacity: 0.3, translateY: 0 }}
      animate={{ opacity: 1, translateY: -2 }}
      transition={{
        type: 'timing',
        duration: PULSE_DURATION,
        delay,
        loop: true,
        repeatReverse: true,
      }}
      style={[styles.dot, { backgroundColor: color }]}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
