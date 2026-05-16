// Round phone-FAB used to start or end a call. Thin abstraction over
// GlassButton: locks size to 80px, normalizes the tint per mode, drops in
// the right phone icon. Use the `mode` prop instead of styling per-site.
//
// Sandbox spike sizing: 80px circle. Tints from Tailwind's emerald-500
// (start) and rose-500 (end). Icon stays white in both modes for contrast.

import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { GlassButton } from './GlassButton';

const SIZE = 80;
const ICON_SIZE = 32;
const ICON_COLOR = '#ffffff';

const MODE_TINT = {
  start: '#10b981', // emerald-500
  end: '#f43f5e', // rose-500
} as const;

export interface CallButtonProps {
  mode: 'start' | 'end';
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  /** Optional icon override. When provided, renders this content instead
   *  of the default phone glyph. Use for state variants like the home
   *  FAB's "Call in progress" indicator (lucide PhoneCall). Size + tint
   *  per-mode are preserved either way. */
  children?: ReactNode;
  /** Override tint — used by CallFab when the menu is open to dim the
   *  primary button so satellites read as the active surface. */
  tintColor?: string;
}

export function CallButton({
  mode,
  onPress,
  onLongPress,
  disabled,
  style,
  accessibilityLabel,
  children,
  tintColor,
}: CallButtonProps) {
  // Default content: phone glyph, rotated 135° for 'end' to match the iOS
  // hung-up convention. Consumers can pass `children` to render a custom
  // icon while keeping the rest of the CallButton chrome.
  const defaultIcon = (
    <Ionicons
      name="call"
      size={ICON_SIZE}
      color={ICON_COLOR}
      style={mode === 'end' ? { transform: [{ rotate: '135deg' }] } : undefined}
    />
  );

  return (
    <GlassButton
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      disabled={disabled}
      tintColor={tintColor ?? MODE_TINT[mode]}
      accessibilityLabel={accessibilityLabel ?? (mode === 'start' ? 'Start call' : 'End call')}
      accessibilityRole="button"
      style={[{ width: SIZE, height: SIZE, borderRadius: SIZE / 2 }, style]}
    >
      {children ?? defaultIcon}
    </GlassButton>
  );
}
