// Profile plugin's stack navigation. Two screens: a list of profile/* pages
// and a page detail. Profile reuses WikiPageDetail since the editing affordance
// is identical — the only difference vs Wiki is the scoped page set + tile
// surface.

import { Ionicons } from '@expo/vector-icons';
import {
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRxdbReady } from '../../lib/rxdb/useRxdbReady';
import { useWikiPages } from '../../lib/rxdb/useWikiPages';
import type { WikiPageDoc } from '../../lib/rxdb/schemas';
import { PluginBackRow, pluginStackScreenOptions } from '../PluginStack';
import { WikiPageDetail } from '../WikiPageDetail';

export type ProfileStackParamList = {
  List: undefined;
  Page: { pageId: string };
};

const Stack = createNativeStackNavigator<ProfileStackParamList>();

export function ProfileStack() {
  return (
    <Stack.Navigator screenOptions={pluginStackScreenOptions} initialRouteName="List">
      <Stack.Screen name="List" component={ListScreen} />
      <Stack.Screen name="Page" component={PageScreen} />
    </Stack.Navigator>
  );
}

// List of profile root + 9 children. Root sorted to the top; children
// alphabetically. We deliberately render even pages with empty content —
// users may want to navigate in to add the first section.
function ListScreen({ navigation }: NativeStackScreenProps<ProfileStackParamList, 'List'>) {
  const ready = useRxdbReady();
  const pages = useWikiPages();

  const profilePages = useMemo(() => {
    const profile = pages.filter(
      (p) => p.scope === 'user' && p.type === 'profile' && p.tombstoned_at === null,
    );
    return profile.sort((a, b) => {
      // Root first.
      if (a.slug === 'profile') return -1;
      if (b.slug === 'profile') return 1;
      return a.title.localeCompare(b.title);
    });
  }, [pages]);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Syncing…</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={profilePages}
      keyExtractor={(p) => p.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            Profile pages haven't been seeded yet. They land at signup.
          </Text>
        </View>
      }
      renderItem={({ item }) => <ProfileRow page={item} navigation={navigation} />}
    />
  );
}

function ProfileRow({
  page,
  navigation,
}: {
  page: WikiPageDoc;
  navigation: NativeStackScreenProps<ProfileStackParamList, 'List'>['navigation'];
}) {
  const isRoot = page.slug === 'profile';
  return (
    <Pressable
      style={styles.row}
      onPress={() => navigation.push('Page', { pageId: page.id })}
    >
      <View style={[styles.rowIcon, isRoot && styles.rowIconRoot]}>
        <Ionicons
          name={isRoot ? 'person-circle-outline' : 'document-text-outline'}
          size={20}
          color={isRoot ? '#e8f1ff' : '#7aa3d4'}
        />
      </View>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{page.title}</Text>
        <Text style={styles.rowAbstract} numberOfLines={2}>
          {page.abstract ?? page.agent_abstract}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
    </Pressable>
  );
}

function PageScreen({ navigation, route }: NativeStackScreenProps<ProfileStackParamList, 'Page'>) {
  const pages = useWikiPages();
  const page = pages.find((p) => p.id === route.params.pageId);

  if (!page) {
    return (
      <View style={styles.flex}>
        <PluginBackRow label="Profile" onPress={() => navigation.goBack()} />
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Page not found.</Text>
        </View>
      </View>
    );
  }

  return <WikiPageDetail page={page} onBack={() => navigation.goBack()} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#7aa3d4' },
  list: { paddingVertical: 8 },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#7aa3d4', fontSize: 14, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#11203a',
  },
  rowIconRoot: { backgroundColor: '#1a3055' },
  rowMain: { flex: 1, gap: 4 },
  rowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '500' },
  rowAbstract: { color: '#7aa3d4', fontSize: 13, lineHeight: 17 },
});
