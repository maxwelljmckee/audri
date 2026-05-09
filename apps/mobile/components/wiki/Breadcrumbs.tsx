// Tappable ancestor chain rendered above the wiki page title. Each segment
// pushes a Page screen for that ancestor — visually equivalent to popping
// stack frames but simpler to reason about (just keep pushing, the stack
// grows and the back button still works).

import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { WikiPageDoc } from '../../lib/rxdb/schemas';

interface Props {
  // Ancestors from root → parent (excludes the current page itself).
  ancestors: WikiPageDoc[];
  // Tap a segment; receives the pageId of the tapped ancestor, or null for
  // the root (Wiki home).
  onSegmentPress: (pageId: string | null) => void;
}

export function Breadcrumbs({ ancestors, onSegmentPress }: Props) {
  if (ancestors.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.container}
    >
      <Pressable onPress={() => onSegmentPress(null)} style={styles.segment}>
        <Ionicons name="home-outline" size={14} color="#7aa3d4" />
      </Pressable>
      {ancestors.map((a) => (
        <View key={a.id} style={styles.segmentGroup}>
          <Ionicons name="chevron-forward" size={12} color="#3f5a83" />
          <Pressable onPress={() => onSegmentPress(a.id)} style={styles.segment}>
            <Text style={styles.segmentText} numberOfLines={1}>
              {a.title}
            </Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4,
  },
  segmentGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  segment: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  segmentText: {
    color: '#7aa3d4',
    fontSize: 13,
  },
});
