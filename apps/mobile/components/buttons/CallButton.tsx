// Round phone-FAB used to start or end a call. Thin abstraction over
// GlassButton: locks size to 80px, normalizes the tint per mode, drops in
// the right phone icon. Use the `mode` prop instead of styling per-site.
//
// Sandbox spike sizing: 80px circle. Tints from Tailwind's emerald-500
// (start) and rose-500 (end). Icon stays white in both modes for contrast.

import { Ionicons } from '@expo/vector-icons';
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
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function CallButton({
  mode,
  onPress,
  disabled,
  style,
  accessibilityLabel,
}: CallButtonProps) {
  return (
    <GlassButton
      onPress={onPress}
      disabled={disabled}
      tintColor={MODE_TINT[mode]}
      accessibilityLabel={accessibilityLabel ?? (mode === 'start' ? 'Start call' : 'End call')}
      accessibilityRole="button"
      style={[{ width: SIZE, height: SIZE, borderRadius: SIZE / 2 }, style]}
    >
      <Ionicons
        name="call"
        size={ICON_SIZE}
        color={ICON_COLOR}
        // 'end' = the iOS-style hung-up rotation. Same icon, 135° turn.
        style={mode === 'end' ? { transform: [{ rotate: '135deg' }] } : undefined}
      />
    </GlassButton>
  );
}
