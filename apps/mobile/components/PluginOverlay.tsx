import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useEffect, useState } from "react";
import { Dimensions, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { type PluginKind, usePluginOverlay } from "../lib/usePluginOverlay";

const { width: SW, height: SH } = Dimensions.get("window");
const ANIM_DURATION = 320;

interface Props {
  kind: PluginKind;
  title: string;
  children: React.ReactNode;
}

// Scale-from-tile-to-fullscreen overlay. Reads origin rect from store; when
// open, animates from that rect (the tile's screen position) to fullscreen.
//
// We READ origin via React state (not shared value) and feed it into the
// Reanimated worklet. Origin doesn't change during the animation so this is
// stable.

export function PluginOverlay({ kind, title, children }: Props) {
  const open = usePluginOverlay((s) => s.open);
  const origin = usePluginOverlay((s) => s.origin);
  const hide = usePluginOverlay((s) => s.hide);
  const isOpen = open === kind;

  const t = useSharedValue(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) setMounted(true);
    t.value = withTiming(
      isOpen ? 1 : 0,
      { duration: ANIM_DURATION, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished && !isOpen) runOnJS(setMounted)(false);
      },
    );
  }, [isOpen, t]);

  // Fallback to screen-center small square if no origin captured.
  const fromX = origin?.x ?? SW / 2 - 32;
  const fromY = origin?.y ?? SH / 2 - 32;
  const fromW = origin?.width ?? 64;
  const fromH = origin?.height ?? 64;

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: t.value * 0.55,
  }));

  const sheetStyle = useAnimatedStyle(() => {
    const x = interpolate(t.value, [0, 1], [fromX, 0]);
    const y = interpolate(t.value, [0, 1], [fromY, 0]);
    const w = interpolate(t.value, [0, 1], [fromW, SW]);
    const h = interpolate(t.value, [0, 1], [fromH, SH]);
    const radius = interpolate(t.value, [0, 1], [16, 0]);
    const opacity = interpolate(t.value, [0, 0.15, 1], [0, 1, 1], "clamp");
    return {
      position: "absolute",
      left: x,
      top: y,
      width: w,
      height: h,
      borderRadius: radius,
      opacity,
    };
  });

  const contentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0.4, 1], [0, 1], "clamp"),
  }));

  if (!mounted && !isOpen) return null;

  return (
    <View
      style={StyleSheet.absoluteFillObject}
      pointerEvents={isOpen ? "auto" : "none"}
    >
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={hide} />
      </Animated.View>

      <Animated.View style={[styles.sheet, sheetStyle]}>
        {/* Gentle frosted-glass effect — blurs the LavaLamp showing through
            the sheet's translucent azure tint. Sits as the first child so
            it paints behind everything else inside the sheet. */}
        <BlurView
          intensity={30}
          tint="dark"
          style={StyleSheet.absoluteFillObject}
        />
        <Animated.View style={[styles.fill, contentStyle]}>
          <SafeAreaView edges={["top"]} style={styles.fill}>
            <View style={styles.header}>
              <View style={styles.headerSpacer} />
              <View style={styles.titleWrap}>
                <Animated.Text style={styles.title}>{title}</Animated.Text>
              </View>
              <Pressable onPress={hide} style={styles.close} hitSlop={12}>
                <Ionicons name="close" size={22} color="#e8f1ff" />
              </Pressable>
            </View>
            <View style={styles.fill}>{children}</View>
          </SafeAreaView>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
  },
  sheet: {
    // Desaturated variant of azure-bg to match the LavaLamp's post-blur
    // surface (which the user sees as muted, not the saturated #0a1628).
    backgroundColor: "rgba(12, 19, 32, 0.8)",
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1f2f4d",
  },
  headerSpacer: { width: 32 },
  titleWrap: { flex: 1, alignItems: "center" },
  title: { color: "#e8f1ff", fontSize: 17, fontWeight: "600" },
  close: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    backgroundColor: "#11203a",
  },
});
