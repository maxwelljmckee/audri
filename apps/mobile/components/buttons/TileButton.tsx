// Square plugin tile — icon on top, label below. Thin abstraction over
// GlassButton that locks the aspect ratio + vertical layout. Drop in
// alongside siblings in a flex row; each TileButton becomes a square.
//
// Replaces the per-tile styling that used to live in components/PluginTile.
// PluginTile-the-export still exists as the call-site shim that passes the
// origin coordinates back up for the scale-from-tile launch animation.

import { Ionicons } from '@expo/vector-icons';
import { Text, type StyleProp, type ViewStyle } from 'react-native';
import { GlassButton } from './GlassButton';

const ICON_SIZE = 28;
const ICON_COLOR = '#e8f1ff'; // azure-text
const LABEL_COLOR = '#e8f1ff';

export interface TileButtonProps {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  disabled?: boolean;
  /** Outer override — flex / margin / etc. The square aspect ratio is
   *  enforced internally so consumers don't need to set it. */
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function TileButton({
  label,
  icon,
  onPress,
  disabled,
  style,
  accessibilityLabel,
}: TileButtonProps) {
  return (
    <GlassButton
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      style={[{ aspectRatio: 1, borderRadius: 16 }, style]}
      contentStyle={{ gap: 8 }}
    >
      <Ionicons name={icon} size={ICON_SIZE} color={ICON_COLOR} />
      <Text style={{ color: LABEL_COLOR, fontSize: 13 }}>{label}</Text>
    </GlassButton>
  );
}
