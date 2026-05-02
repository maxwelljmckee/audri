// JS-side launch animation: `Audri` → `Ai` by collapsing the middle three
// letters inward, opacity + clipped-width together. Mounts above everything
// in app/_layout.tsx; unmounts itself once done. Plays once per cold start.

import { useEffect, useState } from "react";
import { StyleSheet, Text } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { useSplashAnimation } from "../lib/useSplashAnimation";

// Choreography (ms). Hold → collapse → settle → fade → complete.
const HOLD_MS = 700;
const COLLAPSE_MS = 200;
const SETTLE_MS = 400;
const FADE_MS = 300;

// Breath (one-way scale-up during the hold — grows gently, then stays at
// peak through collapse + settle + fade). Amplitude kept small so it reads
// as "alive" rather than "moving."
const BREATH_MAX_SCALE = 1.05;

const FONT_FAMILY = "Comfortaa_400Regular";
const FONT_SIZE = 48;
const TEXT_COLOR = "#e8f1ff"; // azure-text
const BG_COLOR = "#0a1628"; // azure-bg

// Fast-out-slow-in cubic. Standard Material curve for "expressive" motion.
const EASE = Easing.bezier(0.4, 0, 0.2, 1);

export function SplashAnimation() {
  const done = useSplashAnimation((s) => s.done);
  const complete = useSplashAnimation((s) => s.complete);
  const [middleWidth, setMiddleWidth] = useState<number | null>(null);

  // 1 = full width / fully visible; 0 = collapsed + invisible. Drives both
  // the clipping container's width and its opacity off the same value so
  // the collapse and fade are perfectly synchronized.
  const collapse = useSharedValue(1);
  const overlayOpacity = useSharedValue(1);
  const breathe = useSharedValue(1);

  // Start the breath as soon as the component mounts — independent of the
  // udr-width measurement, so the wordmark is "alive" from the first frame.
  // Single one-way grow timed to the hold so the peak coincides with the
  // collapse start; ease-out so growth decelerates into rest. Stays at
  // peak scale through collapse + settle + fade.
  useEffect(() => {
    if (done) return;
    breathe.value = withTiming(BREATH_MAX_SCALE, {
      duration: HOLD_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [done, breathe]);

  useEffect(() => {
    if (done) return;
    if (middleWidth === null) return;

    collapse.value = withDelay(
      HOLD_MS,
      withTiming(0, { duration: COLLAPSE_MS, easing: EASE }),
    );

    const fadeStart = HOLD_MS + COLLAPSE_MS + SETTLE_MS;
    overlayOpacity.value = withDelay(
      fadeStart,
      withTiming(0, { duration: FADE_MS, easing: EASE }, (finished) => {
        if (finished) runOnJS(complete)();
      }),
    );
  }, [done, middleWidth, collapse, overlayOpacity, complete]);

  const middleStyle = useAnimatedStyle(() => {
    if (middleWidth === null) {
      // Pre-measurement: don't animate yet. Container takes its natural
      // width via the inner Text's intrinsic layout.
      return {};
    }
    return {
      width: collapse.value * middleWidth,
      opacity: collapse.value,
    };
  });

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.value,
  }));

  // Apply the breath to the row so all three letters scale together from
  // the row's center. Layout-frame dimensions captured by onLayout are
  // pre-transform, so the udr-width measurement stays valid throughout.
  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ scale: breathe.value }],
  }));

  if (done) return null;

  return (
    <Animated.View pointerEvents="none" style={[styles.overlay, overlayStyle]}>
      <Animated.View style={[styles.row, rowStyle]}>
        <Text style={styles.letter}>A</Text>
        <Animated.View style={[styles.middle, middleStyle]}>
          {/* numberOfLines + flexShrink:0 keep the text on a single line as
              the parent's width animates to 0 — otherwise the inner Text
              tries to reflow into multiple lines, growing the container
              vertically and breaking the row baseline. ellipsizeMode='clip'
              suppresses the default tail-ellipsis RN draws when the Text
              can't fit; we want hard clipping by the parent's overflow,
              not "udr…" mid-collapse. */}
          <Text
            numberOfLines={1}
            ellipsizeMode="clip"
            style={[styles.letter, styles.middleText]}
            onLayout={(e) => {
              if (middleWidth === null) {
                setMiddleWidth(e.nativeEvent.layout.width);
              }
            }}
          >
            udr
          </Text>
        </Animated.View>
        <Text style={styles.letter}>i</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BG_COLOR,
    alignItems: "center",
    justifyContent: "center",
    // Render above everything else mounted in the root layout (overlays,
    // status bar). Z-index isn't enough on Android; absolute-fill at the
    // bottom of the root tree handles the stacking on both platforms.
    zIndex: 9999,
    elevation: 9999,
  },
  row: {
    flexDirection: "row",
    alignItems: "baseline",
  },
  middle: {
    overflow: "hidden",
  },
  middleText: {
    flexShrink: 0,
  },
  letter: {
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    color: TEXT_COLOR,
    // Disable default line-height padding so letters share a clean baseline
    // regardless of platform metrics.
    includeFontPadding: false,
  },
});
