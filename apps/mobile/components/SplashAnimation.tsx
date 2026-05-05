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

// Choreography (ms). Pre-roll → hold (with breath+lift) → collapse → settle
// → fade → complete. Pre-roll is a static beat at rest before any motion
// starts, so the wordmark registers before it begins to move.
const PRE_ROLL_MS = 200;
const HOLD_MS = 800;
const COLLAPSE_MS = 200;
const SETTLE_MS = 500;
const FADE_MS = 300;

// Breath (one-way scale-up during the hold — grows gently, then stays at
// peak through collapse + settle + fade). Amplitude kept small so it reads
// as "alive" rather than "moving."
const BREATH_MAX_SCALE = 1.08;

// Subtle upward drift paired with the breath — the wordmark gently lifts
// during the hold, then stays at peak Y through the collapse + settle + fade.
// Negative Y in RN coordinate space = up.
const LIFT_MAX_Y = -4;

const FONT_FAMILY = "Comfortaa_400Regular";
const FONT_SIZE = 48;
const TEXT_COLOR = "#e8f1ff"; // azure-text
// Slightly desaturated + darker than azure-bg (#0a1628) so the surface
// reads similarly to the LavaLamp's post-blur output, which the splash
// fades onto. Tweak knob if it drifts: keep R/G close together, B only
// modestly higher → muted-blue.
const BG_COLOR = "#0c1320"; // rgb(12, 19, 32) — desat azure

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
  const lift = useSharedValue(0);
  // Wordmark opacity during the intro. Starts at 0 (invisible during the
  // pre-roll beat), fades to 1 paired with breath + lift, stays at 1 through
  // collapse + settle. Distinct from `overlayOpacity` which fades the whole
  // overlay out at the very end of the choreography.
  const textOpacity = useSharedValue(0);

  // After the pre-roll: opacity + breath + lift all kick off together so
  // the wordmark fades in while it grows + lifts. One-way, timed to the
  // hold so the peak coincides with the collapse start; ease-out so growth
  // decelerates into rest. Stays at peak through collapse + settle + fade.
  useEffect(() => {
    if (done) return;
    const easing = Easing.out(Easing.cubic);
    textOpacity.value = withDelay(
      PRE_ROLL_MS,
      withTiming(1, { duration: HOLD_MS, easing }),
    );
    breathe.value = withDelay(
      PRE_ROLL_MS,
      withTiming(BREATH_MAX_SCALE, { duration: HOLD_MS, easing }),
    );
    lift.value = withDelay(
      PRE_ROLL_MS,
      withTiming(LIFT_MAX_Y, { duration: HOLD_MS, easing }),
    );
  }, [done, textOpacity, breathe, lift]);

  useEffect(() => {
    if (done) return;
    if (middleWidth === null) return;

    collapse.value = withDelay(
      PRE_ROLL_MS + HOLD_MS,
      withTiming(0, { duration: COLLAPSE_MS, easing: EASE }),
    );

    const fadeStart = PRE_ROLL_MS + HOLD_MS + COLLAPSE_MS + SETTLE_MS;
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

  // Apply the breath + lift + intro opacity to the row so all three letters
  // fade in, scale, and rise together. Layout-frame dimensions captured by
  // onLayout are pre-transform, so the udr-width measurement stays valid
  // throughout.
  const rowStyle = useAnimatedStyle(() => ({
    opacity: textOpacity.value,
    transform: [{ translateY: lift.value }, { scale: breathe.value }],
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
