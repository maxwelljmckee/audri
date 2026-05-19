// Pressable surface with a Liquid Glass effect on iOS 26+ (via
// expo-glass-effect) and a graceful BlurView fallback elsewhere
// (Android, older iOS). The two surfaces are visually similar enough
// that consumers don't need to branch — pass children, get a glass-y
// pressable, on whatever the device supports.
//
// This is the base. Use the thin abstractions in this folder
// (CallButton, TileButton, …) for normalized, use-case-specific styling
// rather than calling GlassButton directly from screen code.

import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import {
  type GestureResponderEvent,
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

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

export interface GlassButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  /** Outer container style — use to set width / height / borderRadius / aspectRatio. */
  style?: StyleProp<ViewStyle>;
  /** Inner content padding / centering style. Defaults to centered with no padding. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Glass effect style passed through on iOS 26+. Default 'regular'. */
  glassEffectStyle?: 'clear' | 'regular';
  /** Optional tint applied via the native glass `tintColor` prop on iOS 26+. */
  tintColor?: string;
  /** Blur intensity used by the BlurView fallback (0–100). Default 50. */
  blurIntensity?: number;
  /** Blur tint scheme used by the BlurView fallback. Default 'dark'. */
  blurTint?: 'light' | 'dark' | 'default';
  /** Force the BlurView fallback even on iOS 26+ where Liquid Glass is
   *  available. Use only at call sites where Liquid Glass is known to
   *  misrender — currently the CallFab satellites, whose `MotiView`
   *  transform wrapper + Modal presentation layer together break
   *  `UIVisualEffectView`'s backdrop snapshot on iOS 26. Revisit when
   *  `expo-glass-effect` or iOS resolves the interaction. */
  forceFallback?: boolean;
  children: React.ReactNode;
}

export function GlassButton({
  style,
  contentStyle,
  glassEffectStyle = 'clear',
  tintColor,
  blurIntensity = 50,
  blurTint = 'dark',
  forceFallback = false,
  disabled,
  onPress,
  onLongPress,
  children,
  ...pressableProps
}: GlassButtonProps) {
  const useLiquidGlass = LIQUID_GLASS_OK && !forceFallback;
  // Pull borderRadius out of the consumer's style so we can also apply it
  // to the absolute-positioned glass / blur children. iOS's native
  // BlurView paints its own rectangular bounds and ignores the parent's
  // `overflow: hidden` + borderRadius clip — without this, corners look
  // squared on one side and a hairline blur escapes the clip.
  const flatStyle = StyleSheet.flatten(style) ?? {};
  const radius = flatStyle.borderRadius;
  const childRadius = radius != null ? { borderRadius: radius } : undefined;

  // Colored overlay used on the BlurView fallback path to give tinted
  // buttons saturation that matches what Liquid Glass produces natively.
  // The previous "Pressable bg behind the BlurView" approach got
  // attenuated by the blur's dark tint and read as muddy/grey. This
  // sits ON TOP of the BlurView (BlurView still provides the frosted
  // texture; this layer adds the color). Only rendered inside the
  // BlurView branch of the JSX below — Liquid Glass path is unaffected
  // because that branch never mounts this overlay.
  // Alpha tunable: `80` ~50% / `99` ~60% / `cc` ~80%. Higher = more pop.
  const fallbackTintOverlay =
    tintColor && /^#[0-9a-fA-F]{6}$/.test(tintColor) ? `${tintColor}99` : null;

  // Haptics on every successful press (skipped when disabled — the
  // Pressable's `disabled` prop already short-circuits handlers in that
  // case). Light buzz on tap, medium on long-press for a stronger sense
  // of "you triggered the alternate action." Failures are swallowed:
  // haptics aren't supported on simulators / older devices, and a missing
  // tap-buzz isn't worth a crash.
  const handlePress = (e: GestureResponderEvent) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress?.(e);
  };
  const handleLongPress = (e: GestureResponderEvent) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onLongPress?.(e);
  };

  return (
    <Pressable
      {...pressableProps}
      disabled={disabled}
      onPress={onPress ? handlePress : undefined}
      onLongPress={onLongPress ? handleLongPress : undefined}
      style={({ pressed }) => [
        // Press + disabled feedback consolidated here so consumers don't
        // have to re-implement them per call-site.
        { opacity: disabled ? 0.4 : pressed ? 0.7 : 1, overflow: 'hidden' },
        // Subtle edge + surface wash substitutes for the bright halo
        // Liquid Glass paints natively. Only on the BlurView fallback —
        // on the Liquid Glass path GlassView produces its own edge and
        // these would stack on top, doubling the highlight.
        !useLiquidGlass && FALLBACK_SURFACE_STYLE,
        style,
      ]}
    >
      {useLiquidGlass ? (
        <GlassView
          style={[StyleAbsoluteFill, childRadius]}
          glassEffectStyle={glassEffectStyle}
          tintColor={tintColor}
          isInteractive={false}
        />
      ) : (
        <>
          <BlurView
            intensity={blurIntensity}
            tint={blurTint}
            style={[StyleAbsoluteFill, childRadius]}
          />
          {fallbackTintOverlay ? (
            <View
              pointerEvents="none"
              style={[StyleAbsoluteFill, childRadius, { backgroundColor: fallbackTintOverlay }]}
            />
          ) : null}
        </>
      )}
      <View style={[StyleAbsoluteFill, StyleCenter, contentStyle]}>{children}</View>
    </Pressable>
  );
}

// Hand-rolled (vs StyleSheet.absoluteFillObject) to avoid creating a
// StyleSheet just for two static keys. Same shape, no perf difference.
const StyleAbsoluteFill = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};
const StyleCenter = {
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};
// Light edge + faint surface wash. Tunable knobs:
//   - borderWidth: 1 reads as a hairline at @2x/@3x. Bump to 1.5 for more
//     definition.
//   - borderColor alpha: 0.18 is "barely there" white. Push to 0.25-0.35
//     to make the edge more pronounced.
//   - backgroundColor alpha: 0.04 lets the surface glow faintly even
//     when the BlurView underneath captures a dark bg. Drop to 0.02 for
//     near-invisible, push to 0.08 for a more pronounced wash.
const FALLBACK_SURFACE_STYLE = {
  borderWidth: 1,
  borderColor: 'rgba(255, 255, 255, 0.3)',
  backgroundColor: 'rgba(255, 255, 255, 0.04)',
};
