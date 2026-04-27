import { Ionicons } from '@expo/vector-icons';
import { useRef } from 'react';
import { Pressable, type PressableProps, StyleSheet, Text, View } from 'react-native';
import type { OriginRect } from '../lib/usePluginOverlay';

interface Props {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPressWithOrigin?: (origin: OriginRect) => void;
  onPress?: () => void;
}

// Tile = colored icon-card with label below (separate text). Press captures
// own screen rect via measureInWindow → fed to overlay for scale animation.
export function PluginTile({ label, icon, onPress, onPressWithOrigin }: Props) {
  const ref = useRef<View>(null);

  const handlePress: PressableProps['onPress'] = () => {
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
        <Pressable
          onPress={handlePress}
          style={({ pressed }) => [styles.card, pressed && styles.pressed]}
        >
          <Ionicons name={icon} size={26} color="#7aa3d4" />
        </Pressable>
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
  card: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: '#11203a',
  },
  pressed: { opacity: 0.7 },
  label: {
    color: '#e8f1ff',
    fontSize: 12,
    fontWeight: '500',
  },
});
