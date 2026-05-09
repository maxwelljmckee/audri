import { BlurView } from 'expo-blur';
import randomColor from 'randomcolor';
import { useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

function randomNumber(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

type LavaLampProps = {
  count?: number;
  hue?: string;
  intensity?: number;
  colors?: string[];
  duration?: number;
  /** Solid background color painted underneath the blobs. When provided,
   *  skips the random hue-derived background. Use to lock the lava lamp
   *  to the app theme. */
  bgColor?: string;
  /** BlurView tint scheme. Original component hardcoded 'light' which
   *  washes a dark theme to white. Default kept as 'light' for backward
   *  compatibility; pass 'dark' on dark themes. */
  tint?: 'light' | 'dark' | 'default';
  /** When true, freezes each blob's rotation at its current angle. Use to
   *  pause the animation when the surface isn't visible (e.g. a plugin
   *  overlay is covering it) — saves continuous GPU work for nothing. */
  paused?: boolean;
};

type Circle = {
  x: number;
  y: number;
  radius: number;
  index: number;
  color: string;
};
type CircleProps = {
  circle: Circle;
  duration?: number;
  withBlur?: boolean;
  paused?: boolean;
};

export function LavaLamp({
  count = 4,
  hue = 'green',
  intensity = 100,
  colors,
  duration,
  bgColor,
  tint = 'light',
  paused = false,
}: LavaLampProps) {
  const { width, height } = useWindowDimensions();
  // biome-ignore lint/correctness/useExhaustiveDependencies: width/height intentionally excluded — blob positions are stable per mount and shouldn't scramble on rotation
  const circles = useMemo<Circle[]>(() => {
    const _colors =
      colors ??
      randomColor({
        count,
        hue,
        format: 'rgba',
        luminosity: 'light',
        alpha: 0.3,
      });
    return _colors.map((color, index) => {
      // randomNumber(min, max) is inclusive on both ends. /10 maps to
      // a [min/10, max/10] decimal. Radius = blob diameter as fraction
      // of screen width / 2. Lowered the max from 12 → 10 to keep the
      // largest blobs under width × 0.5 instead of width × 0.6.
      const rand = randomNumber(5, 10) / 10;
      const radius = (width * rand) / 2;
      // Placement math:
      //   - Each blob orbits around (width/2, cy) with orbit radius
      //     |cx - width/2|.
      //   - cy is sampled from a vertical band so blobs aren't too close
      //     to the very top/bottom (their max orbit would be tiny there).
      //   - orbitR is biased toward the upper end of its available range
      //     so motion is consistently visible.
      //   - OVERSHOOT_FRAC lets the blob's CENTER drift past each screen
      //     edge by that fraction of the screen dimension. Set to 0 for
      //     "centers strictly on-screen"; raise to allow more drift.
      const Y_BAND_MIN = 0.2;
      const Y_BAND_MAX = 0.8;
      const ORBIT_MIN_FRAC = 0.6;
      const OVERSHOOT_FRAC = 0.2;
      const overshootY = height * OVERSHOOT_FRAC;
      const overshootX = width * OVERSHOOT_FRAC;
      const cy = height * Y_BAND_MIN + Math.random() * height * (Y_BAND_MAX - Y_BAND_MIN);
      const maxOrbitR = Math.min(cy + overshootY, height - cy + overshootY, width / 2 + overshootX);
      const orbitR = maxOrbitR * (ORBIT_MIN_FRAC + Math.random() * (1 - ORBIT_MIN_FRAC));
      const offsetFromCenter = (Math.random() * 2 - 1) * orbitR;
      return {
        x: width / 2 + offsetFromCenter,
        y: cy,
        radius,
        index,
        color,
      };
    });
  }, [count, hue, colors]);
  // Honor the explicit background color when given; otherwise fall back to
  // the original hue-derived dark color.
  const resolvedBg = bgColor ?? randomColor({ hue, count: 1, luminosity: 'dark' })[0];

  return (
    <View style={[StyleSheet.absoluteFillObject, { backgroundColor: resolvedBg }]}>
      {circles.map((circle) => {
        return (
          <Circle
            key={`circle-${circle.color}-${circle.index}`}
            circle={circle}
            duration={duration}
            withBlur={intensity !== 0}
            paused={paused}
          />
        );
      })}
      <BlurView style={StyleSheet.absoluteFillObject} intensity={intensity} tint={tint} />
    </View>
  );
}

function Circle({ circle, duration = 10000, withBlur, paused }: CircleProps) {
  // Stable random seed for the rotation start angle. useRef holds it
  // across re-renders so pause/resume cycles don't pick a new angle.
  const seedRef = useRef(Math.random() * 360);
  const rotation = useSharedValue(seedRef.current);

  // Lifecycle:
  //   - On mount (paused=false): kick off the infinite rotation from the
  //     seed angle.
  //   - On pause: cancelAnimation freezes the shared value at its current
  //     angle.
  //   - On resume: restart the rotation FROM the current angle so the
  //     blob picks up where it left off (no jump).
  useEffect(() => {
    if (paused) {
      cancelAnimation(rotation);
      return;
    }
    const start = rotation.value;
    rotation.value = withRepeat(
      withSequence(
        withTiming(start, { duration: 0 }),
        withTiming(start + 360, { duration, easing: Easing.linear }),
      ),
      -1,
      false,
    );
  }, [paused, duration, rotation]);

  const stylez = useAnimatedStyle(() => {
    return {
      transform: [
        {
          rotate: `${rotation.value}deg`,
        },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFillObject,
        stylez,
        {
          transformOrigin: ['50%', circle.y, 0],
        },
      ]}
    >
      <View
        style={[
          {
            backgroundColor: circle.color,
            position: 'absolute',
            left: circle.x - circle.radius,
            top: circle.y - circle.radius,
            width: circle.radius * 2,
            height: circle.radius * 2,
            borderRadius: circle.radius,
            // This is using React Native 0.76
            filter: Platform.OS === 'android' ? 'blur(10px)' : '',
          },
        ]}
      />
      {withBlur && Platform.OS === 'ios' && (
        <BlurView style={StyleSheet.absoluteFillObject} intensity={5} tint="light" />
      )}
    </Animated.View>
  );
}
