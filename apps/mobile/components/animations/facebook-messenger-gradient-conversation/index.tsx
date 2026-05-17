// iMessage-style gradient chat. Originally from AnimateReactNative.com,
// refactored here as a parameterized component.
//
// MaskedView technique: all bubbles in the mask are uniformly opaque,
// the body of the masked region holds a screen-height vertical gradient
// that's translated by scrollY (so it stays viewport-fixed while bubbles
// scroll past). A visible-text overlay above the masked gradient paints
// agent bubbles solid (covering the gradient at those positions) and
// leaves user bubbles transparent (so the gradient shows through, cut
// to the bubble shape by the mask).
//
// Two named exports:
//
//   MessengerGradientChat — props-driven component. Pass it a `messages`
//     array; it owns the scroll + animation. forwardRef exposes the
//     inner ScrollView so consumers can scrollToEnd() on new messages.
//
// Default export is the original scaffold demo (100 random messages),
// useful as a runnable reference.

import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { forwardRef, useState } from 'react';
import { Dimensions, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

const { width, height: SCREEN_HEIGHT } = Dimensions.get('window');
const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);
const AnimatedMaskedView = Animated.createAnimatedComponent(MaskedView);

const DEFAULT_GRADIENT = ['#FD84AA', '#A38CF9', '#09E0FF'] as const;
const DEFAULT_AGENT_BUBBLE = '#E4E7EB';
const DEFAULT_AGENT_TEXT = '#111927';
const DEFAULT_USER_TEXT = '#ffffff';

export interface MessengerMessage {
  /** Stable identity per message — used as React key. */
  id: string;
  /** True = user's own message (gradient bubble, right-aligned).
   *  False = other party (solid bubble, left-aligned). */
  mine: boolean;
  /** Plain-text content. Multiline supported. */
  text: string;
}

export interface MessengerGradientChatProps {
  messages: MessengerMessage[];
  /** Three+ color stops for the user-bubble gradient. Vertical
   *  top → bottom by default. */
  gradientColors?: readonly [string, string, ...string[]];
  /** Fill color for "other party" bubbles. */
  agentBubbleColor?: string;
  /** Text color inside agent (other party) bubbles. */
  agentTextColor?: string;
  /** Text color inside user (mine) bubbles. */
  userTextColor?: string;
  /** Outer Animated.ScrollView style. Default: flex 1. */
  style?: StyleProp<ViewStyle>;
  /** ScrollView contentContainerStyle (padding, etc.). */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Optional content rendered below the message list, inside the
   *  scrollview — useful for empty-state messages, status hints, etc.
   *  Only rendered in 'scroll-parallax' mode. */
  footer?: React.ReactNode;
  /** Rendering mode.
   *  - `'scroll-parallax'` (default): outer Animated.ScrollView owns the
   *    scroll; gradient stays viewport-fixed via translateY-by-scrollY.
   *    Use this for live chat screens where the consumer wants the
   *    component to handle scrolling internally.
   *  - `'static'`: no outer scrollview — bubbles + gradient render in
   *    a plain View, gradient is content-anchored (stretches to fit the
   *    bubble stack height). Use when embedding inside an outer scroll
   *    that the consumer already owns (e.g. a transcript view with
   *    additional header / metadata sections above the bubbles). */
  mode?: 'scroll-parallax' | 'static';
  /** Diagnostic: bypass the MaskedView + gradient entirely and render
   *  bubbles as plain colored Views with visible text. Use to isolate
   *  whether a "no text" bug is in the masking layer or upstream
   *  (data flow). Defaults to false. */
  debugBypassMask?: boolean;
}

/**
 * Scroll-following gradient chat. The gradient sits behind user bubbles
 * (visible only through them, masked by their silhouettes) and stays
 * viewport-fixed while the conversation scrolls.
 *
 * The ref is the inner Animated.ScrollView — call `scrollToEnd` on it
 * when new messages arrive.
 */
export const MessengerGradientChat = forwardRef<Animated.ScrollView, MessengerGradientChatProps>(
  function MessengerGradientChat(
    {
      messages,
      gradientColors = DEFAULT_GRADIENT,
      agentBubbleColor = DEFAULT_AGENT_BUBBLE,
      agentTextColor = DEFAULT_AGENT_TEXT,
      userTextColor = DEFAULT_USER_TEXT,
      style,
      contentContainerStyle,
      footer,
      mode = 'scroll-parallax',
      debugBypassMask = false,
    },
    ref,
  ) {
    const scrollY = useSharedValue(0);
    const onScroll = useAnimatedScrollHandler((e) => {
      scrollY.value = e.contentOffset.y;
    });
    const gradientStyle = useAnimatedStyle(() => ({
      transform: [{ translateY: scrollY.value }],
    }));
    // Static mode: track bubble-stack height via onLayout so the
    // gradient can stretch to fit (content-anchored rather than viewport-
    // anchored). Initial fallback is short — first onLayout fires fast.
    const [bubbleStackHeight, setBubbleStackHeight] = useState(200);

    // Diagnostic bypass: skip MaskedView + gradient. Bubbles render as
    // plain colored Views (user = solid pink, agent = solid gray) so the
    // visible-text rendering is fully isolated from any mask/gradient
    // interaction. If text shows here but not in the normal path, the
    // bug is in the masking layer. If text doesn't show even here, the
    // bug is upstream (data flow).
    if (debugBypassMask) {
      return (
        <Animated.ScrollView
          ref={ref}
          scrollEventThrottle={16}
          style={[styles.flex, style]}
          contentContainerStyle={contentContainerStyle}
        >
          {messages.map((m) => (
            <View
              key={`debug-${m.id}`}
              style={[
                styles.messageItem,
                {
                  backgroundColor: m.mine ? '#FD84AA' : agentBubbleColor,
                  alignSelf: m.mine ? 'flex-end' : 'flex-start',
                },
              ]}
            >
              <Text
                style={[styles.visibleText, { color: m.mine ? userTextColor : agentTextColor }]}
              >
                {m.text}
              </Text>
            </View>
          ))}
          {footer}
        </Animated.ScrollView>
      );
    }

    // Static mode: no internal scroll, gradient is content-anchored
    // (stretches to fit the bubble stack height so the top bubble shows
    // the start of the gradient and the bottom bubble shows the end).
    // Use when embedding inside a parent ScrollView the consumer owns
    // (e.g. Call History transcript view with header sections above).
    if (mode === 'static') {
      return (
        <View style={style} onLayout={(ev) => setBubbleStackHeight(ev.nativeEvent.layout.height)}>
          <MaskedView
            renderToHardwareTextureAndroid
            maskElement={
              <View renderToHardwareTextureAndroid style={styles.maskWrapper}>
                {messages.map((m) => (
                  <View
                    key={`mask-${m.id}`}
                    style={[
                      styles.messageItem,
                      styles.bubbleMaskFill,
                      { alignSelf: m.mine ? 'flex-end' : 'flex-start' },
                    ]}
                  >
                    <Text style={[styles.visibleText, styles.hiddenText]}>{m.text}</Text>
                  </View>
                ))}
              </View>
            }
          >
            <View>
              {/* Content-anchored gradient: height matches the bubble
                  stack via the wrapper's onLayout above, so the gradient
                  spans the conversation from top to bottom regardless of
                  how many messages there are. */}
              <LinearGradient
                colors={gradientColors}
                style={[styles.staticGradient, { height: bubbleStackHeight }]}
              />
              {messages.map((m) => (
                <View
                  key={`text-${m.id}`}
                  style={[
                    styles.messageItem,
                    {
                      backgroundColor: m.mine ? 'transparent' : agentBubbleColor,
                      alignSelf: m.mine ? 'flex-end' : 'flex-start',
                    },
                  ]}
                >
                  <Text
                    style={[styles.visibleText, { color: m.mine ? userTextColor : agentTextColor }]}
                  >
                    {m.text}
                  </Text>
                </View>
              ))}
            </View>
          </MaskedView>
        </View>
      );
    }

    return (
      <Animated.ScrollView
        ref={ref}
        onScroll={onScroll}
        scrollEventThrottle={16}
        style={[styles.flex, style]}
        contentContainerStyle={contentContainerStyle}
      >
        <AnimatedMaskedView
          renderToHardwareTextureAndroid
          maskElement={
            // Mask: flow-stacked bubbles, all uniformly opaque white.
            // Same structure as the body's bubble stack below, so the
            // two layouts compute identically — the alpha mask aligns
            // pixel-for-pixel with the visible bubbles.
            <View renderToHardwareTextureAndroid style={styles.maskWrapper}>
              {messages.map((m) => (
                <View
                  key={`mask-${m.id}`}
                  style={[
                    styles.messageItem,
                    styles.bubbleMaskFill,
                    { alignSelf: m.mine ? 'flex-end' : 'flex-start' },
                  ]}
                >
                  <Text style={[styles.visibleText, styles.hiddenText]}>{m.text}</Text>
                </View>
              ))}
            </View>
          }
        >
          {/* Body: bubbles in the SAME flow layout as the mask (so the
              two stacks align). Gradient is absolutely positioned
              behind, translating with scroll for the parallax effect. */}
          <View>
            <AnimatedLinearGradient
              colors={gradientColors}
              style={[styles.gradient, gradientStyle]}
            />
            {messages.map((m) => (
              <View
                key={`text-${m.id}`}
                style={[
                  styles.messageItem,
                  {
                    backgroundColor: m.mine ? 'transparent' : agentBubbleColor,
                    alignSelf: m.mine ? 'flex-end' : 'flex-start',
                  },
                ]}
              >
                <Text
                  style={[styles.visibleText, { color: m.mine ? userTextColor : agentTextColor }]}
                >
                  {m.text}
                </Text>
              </View>
            ))}
          </View>
        </AnimatedMaskedView>
        {footer}
      </Animated.ScrollView>
    );
  },
);

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: 'transparent' },
  maskWrapper: { backgroundColor: 'transparent' },
  messageItem: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    margin: 12,
    marginBottom: 8,
    borderRadius: 12,
    maxWidth: width * 0.65,
  },
  // Mask-layer bubbles are uniformly opaque white. Role differentiation
  // happens in the visible overlay; the mask just defines silhouettes.
  bubbleMaskFill: { backgroundColor: '#ffffff' },
  // Mask-layer text takes layout space (so silhouette sizes match the
  // visible layer above) but renders invisibly. opacity:0 matches the
  // scaffold's original; the bubble's white bg fills the alpha mask
  // regardless of what the (invisible) text element does on top.
  hiddenText: { opacity: 0 },
  // Visible-text styles. Explicit fontSize / lineHeight (rather than
  // relying on RN's platform defaults) so the visible layer's bubble
  // bounds exactly match the mask layer's silhouettes.
  visibleText: { fontSize: 15, lineHeight: 20 },
  // Gradient sits behind the bubbles via absolute positioning; SCREEN_HEIGHT
  // tall so a scroll-translateY keeps it covering the viewport regardless
  // of conversation length. Always sits behind the bubbles in z-order
  // because it's the first child of the body wrapper.
  gradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SCREEN_HEIGHT,
  },
  // Static-mode gradient: explicit height comes from inline style (the
  // measured bubble-stack height). Otherwise same absolute positioning
  // as the scroll-parallax gradient.
  staticGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
});
