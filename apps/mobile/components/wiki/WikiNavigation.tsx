// Wiki plugin's stack navigation. Each screen is a self-contained component;
// they push/pop via React Navigation rather than mutating a `view` state on
// the overlay.
//
// ParamList entries declare the navigation contract. Adding a screen = adding
// a new entry here + a `<Stack.Screen>` registration below + the component.

import {
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRxdbReady } from '../../lib/rxdb/useRxdbReady';
import { useWikiPages } from '../../lib/rxdb/useWikiPages';
import type { WikiPageDoc } from '../../lib/rxdb/schemas';
import { PluginBackRow, pluginStackScreenOptions } from '../PluginStack';
import { WikiPageDetail } from '../WikiPageDetail';

const TYPE_LABELS: Record<string, string> = {
  person: 'People',
  concept: 'Concepts',
  project: 'Projects',
  place: 'Places',
  org: 'Orgs',
  source: 'Sources',
  event: 'Events',
  note: 'Notes',
  profile: 'Profile',
  todo: 'Todos',
};

const TYPE_ICONS: Record<string, React.ComponentProps<typeof Ionicons>['name']> = {
  person: 'people-outline',
  concept: 'bulb-outline',
  project: 'briefcase-outline',
  place: 'location-outline',
  org: 'business-outline',
  source: 'document-text-outline',
  event: 'calendar-outline',
  note: 'create-outline',
  profile: 'person-circle-outline',
  todo: 'checkbox-outline',
};

const TODO_BUCKET_SLUGS = [
  'todos/todo',
  'todos/in-progress',
  'todos/done',
  'todos/archived',
] as const;
type TodoBucketSlug = (typeof TODO_BUCKET_SLUGS)[number];
const TODO_BUCKET_LABELS: Record<TodoBucketSlug, string> = {
  'todos/todo': 'To do',
  'todos/in-progress': 'In progress',
  'todos/done': 'Done',
  'todos/archived': 'Archived',
};

export type WikiStackParamList = {
  Folders: undefined;
  TypeList: { type: string };
  TodoBuckets: undefined;
  TodoBucket: { bucketId: string; bucketSlug: TodoBucketSlug };
  Page: { pageId: string };
};

const Stack = createNativeStackNavigator<WikiStackParamList>();

export function WikiStack() {
  return (
    <Stack.Navigator screenOptions={pluginStackScreenOptions} initialRouteName="Folders">
      <Stack.Screen name="Folders" component={FoldersScreen} />
      <Stack.Screen name="TypeList" component={TypeListScreen} />
      <Stack.Screen name="TodoBuckets" component={TodoBucketsScreen} />
      <Stack.Screen name="TodoBucket" component={TodoBucketScreen} />
      <Stack.Screen name="Page" component={PageScreen} />
    </Stack.Navigator>
  );
}

// ── Screens ────────────────────────────────────────────────────────────────

function FoldersScreen({ navigation }: NativeStackScreenProps<WikiStackParamList, 'Folders'>) {
  const ready = useRxdbReady();
  const pages = useWikiPages();

  const groups = useMemo(() => {
    const m = new Map<string, WikiPageDoc[]>();
    for (const p of pages) {
      const list = m.get(p.type) ?? [];
      list.push(p);
      m.set(p.type, list);
    }
    return [...m.entries()]
      .map(([type, items]) => ({ type, items }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }, [pages]);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Syncing your wiki…</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={groups}
      keyExtractor={(g) => g.type}
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            No pages yet. Have a call with Audri and your wiki will start to populate.
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={() => {
            if (item.type === 'todo') navigation.push('TodoBuckets');
            else navigation.push('TypeList', { type: item.type });
          }}
        >
          <View style={styles.rowIcon}>
            <Ionicons
              name={TYPE_ICONS[item.type] ?? 'document-outline'}
              size={20}
              color="#7aa3d4"
            />
          </View>
          <Text style={styles.rowLabel}>{TYPE_LABELS[item.type] ?? item.type}</Text>
          <Text style={styles.rowCount}>{item.items.length}</Text>
          <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
        </Pressable>
      )}
    />
  );
}

function TypeListScreen({
  navigation,
  route,
}: NativeStackScreenProps<WikiStackParamList, 'TypeList'>) {
  const pages = useWikiPages();
  const items = pages.filter((p) => p.type === route.params.type);

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Wiki" onPress={() => navigation.goBack()} />
      <FlatList
        data={items}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => navigation.push('Page', { pageId: item.id })}
          >
            <View style={styles.pageRowMain}>
              <Text style={styles.pageRowTitle}>{item.title}</Text>
              <Text style={styles.pageRowAbstract} numberOfLines={2}>
                {item.agent_abstract}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
          </Pressable>
        )}
      />
    </View>
  );
}

function TodoBucketsScreen({
  navigation,
}: NativeStackScreenProps<WikiStackParamList, 'TodoBuckets'>) {
  const pages = useWikiPages();
  const todos = pages.filter((p) => p.type === 'todo');

  const bucketBySlug = new Map(
    todos
      .filter((p) => (TODO_BUCKET_SLUGS as readonly string[]).includes(p.slug))
      .map((b) => [b.slug as TodoBucketSlug, b]),
  );

  const childCountByBucketId = new Map<string, number>();
  for (const p of todos) {
    if (!p.parent_page_id) continue;
    if ((TODO_BUCKET_SLUGS as readonly string[]).includes(p.slug)) continue;
    if (p.slug === 'todos') continue;
    childCountByBucketId.set(
      p.parent_page_id,
      (childCountByBucketId.get(p.parent_page_id) ?? 0) + 1,
    );
  }

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Wiki" onPress={() => navigation.goBack()} />
      <FlatList
        data={TODO_BUCKET_SLUGS}
        keyExtractor={(slug) => slug}
        contentContainerStyle={styles.list}
        renderItem={({ item: slug }) => {
          const bucket = bucketBySlug.get(slug);
          if (!bucket) return null;
          const count = childCountByBucketId.get(bucket.id) ?? 0;
          return (
            <Pressable
              style={styles.row}
              onPress={() =>
                navigation.push('TodoBucket', { bucketId: bucket.id, bucketSlug: slug })
              }
            >
              <View style={styles.rowIcon}>
                <Ionicons name="folder-outline" size={20} color="#7aa3d4" />
              </View>
              <Text style={styles.rowLabel}>{TODO_BUCKET_LABELS[slug]}</Text>
              <Text style={styles.rowCount}>{count}</Text>
              <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
            </Pressable>
          );
        }}
      />
    </View>
  );
}

function TodoBucketScreen({
  navigation,
  route,
}: NativeStackScreenProps<WikiStackParamList, 'TodoBucket'>) {
  const pages = useWikiPages();
  const children = pages.filter((p) => p.parent_page_id === route.params.bucketId);
  const label = TODO_BUCKET_LABELS[route.params.bucketSlug];

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Todos" onPress={() => navigation.goBack()} />
      <Text style={styles.bucketTitle}>{label}</Text>
      <FlatList
        data={children}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No todos here yet.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => navigation.push('Page', { pageId: item.id })}
          >
            <View style={styles.pageRowMain}>
              <Text style={styles.pageRowTitle}>{item.title}</Text>
              <Text style={styles.pageRowAbstract} numberOfLines={2}>
                {item.agent_abstract}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
          </Pressable>
        )}
      />
    </View>
  );
}

function PageScreen({ navigation, route }: NativeStackScreenProps<WikiStackParamList, 'Page'>) {
  const pages = useWikiPages();
  const page = pages.find((p) => p.id === route.params.pageId);

  if (!page) {
    return (
      <View style={styles.flex}>
        <PluginBackRow label="Back" onPress={() => navigation.goBack()} />
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
  rowLabel: { flex: 1, color: '#e8f1ff', fontSize: 15, fontWeight: '500' },
  rowCount: { color: '#7aa3d4', fontSize: 13 },
  pageRowMain: { flex: 1, gap: 4 },
  pageRowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '500' },
  pageRowAbstract: { color: '#7aa3d4', fontSize: 13, lineHeight: 17 },
  bucketTitle: {
    color: '#e8f1ff',
    fontSize: 22,
    fontWeight: '600',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
});
