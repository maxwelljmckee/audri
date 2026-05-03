import { Ionicons } from '@expo/vector-icons';
import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { OriginRect } from '../lib/usePluginOverlay';
import { GlassButton } from './buttons';

interface Props {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPressWithOrigin?: (origin: OriginRect) => void;
  onPress?: () => void;
}

// Tile = glass icon-card with label below (separate text). Press captures
// the card's own screen rect via measureInWindow → fed to the plugin
// overlay for the scale-from-tile launch animation. The wrapping View
// holds the ref since GlassButton's hit-target is the right surface to
// measure from.
export function PluginTile({ label, icon, onPress, onPressWithOrigin }: Props) {
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
    <View style={styles.column}>
      <View ref={ref} collapsable={false} style={styles.cardWrap}>
        <GlassButton onPress={handlePress} style={styles.card}>
          <Ionicons name={icon} size={26} color="#7aa3d4" />
        </GlassButton>
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1, alignItems: 'center', gap: 6 },
  cardWrap: { width: '100%', aspectRatio: 1 },
  card: { flex: 1, borderRadius: 16 },
  label: {
    color: '#e8f1ff',
    fontSize: 12,
    fontWeight: '500',
  },
});
