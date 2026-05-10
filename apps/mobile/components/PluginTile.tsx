import type { ReactNode } from 'react';
import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { OriginRect } from '../lib/usePluginOverlay';
import { GlassButton } from './buttons';

interface Props {
  label: string;
  // Icon is a pre-rendered element so each tile can pull from any icon
  // library (Ionicons, MaterialCommunityIcons, lucide-react-native, etc.)
  // without PluginTile committing to a single library's name string.
  // Standard sizing convention: pass `size={36}` and `color="#7aa3d4"` to
  // keep visual weight consistent across libraries.
  icon: ReactNode;
  // Explicit pixel width for the tile. Computed at the grid layer using
  // useWindowDimensions so 4-per-row math is exact across devices.
  // Percentage widths + columnGap caused 4 × 23% + 3 × 12px to overshoot
  // the inner width on real devices, dropping to 3-per-row.
  widthPx: number;
  onPressWithOrigin?: (origin: OriginRect) => void;
  onPress?: () => void;
}

// Tile = glass icon-card with label below (separate text). Press captures
// the card's own screen rect via measureInWindow → fed to the plugin
// overlay for the scale-from-tile launch animation. The wrapping View
// holds the ref since GlassButton's hit-target is the right surface to
// measure from.
export function PluginTile({ label, icon, widthPx, onPress, onPressWithOrigin }: Props) {
  const ref = useRef<View>(null);

  const handlePress = () => {
    if (!onPressWithOrigin) {
      onPress?.();
      return;
    }
    if (!ref.current) {
      onPress?.();
      return;
    }
    ref.current.measureInWindow((x, y, width, height) => {
      onPressWithOrigin({ x, y, width, height });
    });
  };

  return (
    <View style={[styles.column, { width: widthPx }]}>
      <View ref={ref} collapsable={false} style={styles.cardWrap}>
        <GlassButton onPress={handlePress} style={styles.card}>
          {icon}
        </GlassButton>
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Width is set inline via the `widthPx` prop; this stylesheet just covers
  // alignment + gap between the card and label.
  column: { alignItems: 'center', gap: 6 },
  cardWrap: { width: '100%', aspectRatio: 1 },
  card: { flex: 1, borderRadius: 16 },
  label: {
    color: '#e8f1ff',
    fontSize: 12,
    fontWeight: '500',
  },
});
