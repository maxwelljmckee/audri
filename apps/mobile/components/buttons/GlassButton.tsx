// Pressable surface with a Liquid Glass effect on iOS 26+ (via
// expo-glass-effect) and a graceful BlurView fallback elsewhere
// (Android, older iOS). The two surfaces are visually similar enough
// that consumers don't need to branch — pass children, get a glass-y
// pressable, on whatever the device supports.
//
// This is the base. Use the thin abstractions in this folder
// (CallButton, TileButton, …) for normalized, use-case-specific styling
// rather than calling GlassButton directly from screen code.

import { BlurView } from "expo-blur";
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import {
  Pressable,
  type PressableProps,
  StyleSheet,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";

// Resolved once at module load. The native capability doesn't change
// during a session, so caching avoids the API call on every render.
//
// Defensive: both checks can throw if the native module isn't linked
// (e.g. the JS package was installed but pods weren't reinstalled and
// the binary rebuilt). Treat any throw as "not available" → fall back
// to BlurView. Without this, a missing native module crashes app boot.
const LIQUID_GLASS_OK = (() => {
  try {
    return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  } catch {
    return false;
  }
})();

export interface GlassButtonProps extends Omit<
  PressableProps,
  "style" | "children"
> {
  /** Outer container style — use to set width / height / borderRadius / aspectRatio. */
  style?: StyleProp<ViewStyle>;
  /** Inner content padding / centering style. Defaults to centered with no padding. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Glass effect style passed through on iOS 26+. Default 'regular'. */
  glassEffectStyle?: "clear" | "regular";
  /** Optional tint applied via the native glass `tintColor` prop on iOS 26+. */
  tintColor?: string;
  /** Blur intensity used by the BlurView fallback (0–100). Default 50. */
  blurIntensity?: number;
  /** Blur tint scheme used by the BlurView fallback. Default 'dark'. */
  blurTint?: "light" | "dark" | "default";
  children: React.ReactNode;
}

export function GlassButton({
  style,
  contentStyle,
  glassEffectStyle = "clear",
  tintColor,
  blurIntensity = 50,
  blurTint = "dark",
  disabled,
  children,
  ...pressableProps
}: GlassButtonProps) {
  // Pull borderRadius out of the consumer's style so we can also apply it
  // to the absolute-positioned glass / blur children. iOS's native
  // BlurView paints its own rectangular bounds and ignores the parent's
  // `overflow: hidden` + borderRadius clip — without this, corners look
  // squared on one side and a hairline blur escapes the clip.
  const flatStyle = StyleSheet.flatten(style) ?? {};
  const radius = flatStyle.borderRadius;
  const childRadius = radius != null ? { borderRadius: radius } : undefined;

  return (
    <Pressable
      {...pressableProps}
      disabled={disabled}
      style={({ pressed }) => [
        // Press + disabled feedback consolidated here so consumers don't
        // have to re-implement them per call-site.
        { opacity: disabled ? 0.4 : pressed ? 0.7 : 1, overflow: "hidden" },
        style,
      ]}
    >
      {LIQUID_GLASS_OK ? (
        <GlassView
          style={[StyleAbsoluteFill, childRadius]}
          glassEffectStyle={glassEffectStyle}
          tintColor={tintColor}
          isInteractive={false}
        />
      ) : (
        <BlurView
          intensity={blurIntensity}
          tint={blurTint}
          style={[StyleAbsoluteFill, childRadius]}
        />
      )}
      <View style={[StyleAbsoluteFill, StyleCenter, contentStyle]}>
        {children}
      </View>
    </Pressable>
  );
}

// Hand-rolled (vs StyleSheet.absoluteFillObject) to avoid creating a
// StyleSheet just for two static keys. Same shape, no perf difference.
const StyleAbsoluteFill = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};
const StyleCenter = {
  alignItems: "center" as const,
  justifyContent: "center" as const,
};
