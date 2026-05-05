import { BlurView } from "expo-blur";
import randomColor from "randomcolor";
import { useMemo } from "react";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

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
  tint?: "light" | "dark" | "default";
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
};

export function LavaLamp({
  count = 4,
  hue = "green",
  intensity = 100,
  colors,
  duration,
  bgColor,
  tint = "light",
}: LavaLampProps) {
  const { width, height } = useWindowDimensions();
  const circles = useMemo<Circle[]>(() => {
    const _colors =
      colors ??
      randomColor({
        count,
        hue,
        format: "rgba",
        luminosity: "light",
        alpha: 0.3,
      });
    return _colors.map((color, index) => {
      const rand = randomNumber(5, 12) / 10;
      const radius = (width * rand) / 2;
      // Constrain placement so the blob's CENTER stays on-screen for the
      // entire rotation. The blob orbits around (width/2, cy) with orbit
      // radius |cx - width/2|. To keep the orbit inside [0, height]
      // vertically, that radius must be ≤ min(cy, height - cy).
      //
      // Two refinements (otherwise blobs near edges barely move and the
      // surface looks dead):
      //   1. Clamp cy to a middle band so every blob has a usable orbit.
      //   2. Bias orbit radius toward the upper end of its available range
      //      so motion is consistently visible across all blobs.
      // The blob itself (with its radius) can still extend past the screen
      // edges — only the center is constrained.
      const Y_BAND_MIN = 0.2;
      const Y_BAND_MAX = 0.8;
      const ORBIT_MIN_FRAC = 0.6;
      const cy =
        height * Y_BAND_MIN + Math.random() * height * (Y_BAND_MAX - Y_BAND_MIN);
      const maxOrbitR = Math.min(cy, height - cy, width / 2);
      const orbitR =
        maxOrbitR * (ORBIT_MIN_FRAC + Math.random() * (1 - ORBIT_MIN_FRAC));
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
  const resolvedBg =
    bgColor ?? randomColor({ hue, count: 1, luminosity: "dark" })[0];

  return (
    <View
      style={[StyleSheet.absoluteFillObject, { backgroundColor: resolvedBg }]}>
      {circles.map((circle) => {
        return (
          <Circle
            key={`circle-${circle.color}-${circle.index}`}
            circle={circle}
            duration={duration}
            withBlur={intensity !== 0}
          />
        );
      })}
      <BlurView
        style={StyleSheet.absoluteFillObject}
        intensity={intensity}
        tint={tint}
      />
    </View>
  );
}

function Circle({ circle, duration = 10000, withBlur }: CircleProps) {
  // possible a full circle rotation?
  const randRotation = Math.random() * 360;

  const rotation = useDerivedValue(() => {
    return withRepeat(
      withSequence(
        withTiming(randRotation, { duration: 0 }),
        withTiming(randRotation + 360, {
          duration,
          easing: Easing.linear,
        })
      ),
      -1, // also as Infinity
      false // no repeat reverse
    );
  }, [duration]);

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
          transformOrigin: ["50%", circle.y, 0],
        },
      ]}>
      <View
        style={[
          {
            backgroundColor: circle.color,
            position: "absolute",
            left: circle.x - circle.radius,
            top: circle.y - circle.radius,
            width: circle.radius * 2,
            height: circle.radius * 2,
            borderRadius: circle.radius,
            // This is using React Native 0.76
            filter: Platform.OS === "android" ? "blur(10px)" : "",
          },
        ]}
      />
      {withBlur && Platform.OS === "ios" && (
        <BlurView
          style={StyleSheet.absoluteFillObject}
          intensity={5}
          tint='light'
        />
      )}
    </Animated.View>
  );
}
