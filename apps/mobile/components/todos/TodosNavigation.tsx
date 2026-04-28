// Todos plugin's stack navigation. Three screens: list (with status-bucket
// tabs), detail (reuses WikiPageDetail), and a manual-create form.
//
// Status is encoded by parent_page_id pointing at one of the four bucket
// pages. Check-off reparents the page to todos/done — that's a single
// UPDATE on wiki_pages, which RxDB can push directly via the existing RLS
// policy (UPDATE allowed for own user-scope pages).

import { Ionicons } from '@expo/vector-icons';
import {
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getDatabase } from '../../lib/rxdb/database';
import type { AgentTaskDoc, WikiPageDoc } from '../../lib/rxdb/schemas';
import { useActiveAgentTasks } from '../../lib/rxdb/useAgentTasks';
import { useRxdbReady } from '../../lib/rxdb/useRxdbReady';
import { useWikiPages } from '../../lib/rxdb/useWikiPages';
import { spawnTodo } from '../../lib/spawnTodo';
import { PluginBackRow, pluginStackScreenOptions } from '../PluginStack';
import { WikiPageDetail } from '../WikiPageDetail';

const BUCKET_SLUGS = [
  'todos/todo',
  'todos/in-progress',
  'todos/done',
  'todos/archived',
] as const;
type BucketSlug = (typeof BUCKET_SLUGS)[number];
const BUCKET_LABELS: Record<BucketSlug, string> = {
  'todos/todo': 'To do',
  'todos/in-progress': 'In progress',
  'todos/done': 'Done',
  'todos/archived': 'Archived',
};

export type TodosStackParamList = {
  List: undefined;
  Detail: { pageId: string };
  Create: undefined;
};

const Stack = createNativeStackNavigator<TodosStackParamList>();

export function TodosStack() {
  return (
    <Stack.Navigator screenOptions={pluginStackScreenOptions} initialRouteName="List">
      <Stack.Screen name="List" component={ListScreen} />
      <Stack.Screen name="Detail" component={DetailScreen} />
      <Stack.Screen name="Create" component={CreateScreen} />
    </Stack.Navigator>
  );
}

// ── List with bucket tabs ──────────────────────────────────────────────────

function ListScreen({ navigation }: NativeStackScreenProps<TodosStackParamList, 'List'>) {
  const ready = useRxdbReady();
  const pages = useWikiPages();
  const activeResearch = useActiveAgentTasks('research');
  const [activeBucket, setActiveBucket] = useState<BucketSlug>('todos/todo');

  // Build a map of todo_page_id → in-flight task so each row can show its
  // live state (spinner + label) without each row having to subscribe.
  const activeByPageId = useMemo(() => {
    const m = new Map<string, AgentTaskDoc>();
    for (const t of activeResearch) m.set(t.todo_page_id, t);
    return m;
  }, [activeResearch]);

  const { bucketBySlug, childrenByBucketId } = useMemo(() => {
    const todos = pages.filter((p) => p.scope === 'user' && p.type === 'todo');
    const bySlug = new Map<BucketSlug, WikiPageDoc>(
      todos
        .filter((p) => (BUCKET_SLUGS as readonly string[]).includes(p.slug))
        .map((b) => [b.slug as BucketSlug, b]),
    );
    const byId = new Map<string, WikiPageDoc[]>();
    for (const p of todos) {
      if (!p.parent_page_id) continue;
      if ((BUCKET_SLUGS as readonly string[]).includes(p.slug)) continue;
      if (p.slug === 'todos') continue;
      const list = byId.get(p.parent_page_id) ?? [];
      list.push(p);
      byId.set(p.parent_page_id, list);
    }
    return { bucketBySlug: bySlug, childrenByBucketId: byId };
  }, [pages]);

  if (!ready) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Syncing…</Text>
      </View>
    );
  }

  const activeBucketPage = bucketBySlug.get(activeBucket);
  const items = activeBucketPage ? childrenByBucketId.get(activeBucketPage.id) ?? [] : [];

  return (
    <View style={styles.flex}>
      <View style={styles.tabBar}>
        {BUCKET_SLUGS.map((slug) => {
          const bucket = bucketBySlug.get(slug);
          const count = bucket ? childrenByBucketId.get(bucket.id)?.length ?? 0 : 0;
          const isActive = slug === activeBucket;
          return (
            <Pressable
              key={slug}
              style={[styles.tab, isActive && styles.tabActive]}
              onPress={() => setActiveBucket(slug)}
            >
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                {BUCKET_LABELS[slug]}
              </Text>
              {count > 0 ? (
                <Text style={[styles.tabCount, isActive && styles.tabCountActive]}>
                  {count}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <Pressable style={styles.createRow} onPress={() => navigation.push('Create')}>
        <Ionicons name="add-circle-outline" size={22} color="#4d8fdb" />
        <Text style={styles.createRowLabel}>New todo</Text>
      </Pressable>

      <FlatList
        data={items}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No todos in this bucket.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TodoRow
            page={item}
            activeTask={activeByPageId.get(item.id) ?? null}
            doneBucketId={bucketBySlug.get('todos/done')?.id ?? null}
            onOpen={() => navigation.push('Detail', { pageId: item.id })}
          />
        )}
      />
    </View>
  );
}

// Tap the title to drill into the page; tap the round checkbox to toggle the
// page between its current bucket and `todos/done`. Toggle uses RxDB's
// reactive .patch() so the row swaps tabs immediately + propagates to the
// server via the existing replication push.
//
// If the row has an in-flight agent_task (e.g. research is still running),
// we replace the abstract with a "Researching now…" line + spinner and the
// checkbox is disabled — checking off a todo whose work hasn't completed
// would leave the artifact orphaned.
function TodoRow({
  page,
  activeTask,
  doneBucketId,
  onOpen,
}: {
  page: WikiPageDoc;
  activeTask: AgentTaskDoc | null;
  doneBucketId: string | null;
  onOpen: () => void;
}) {
  const isDone = doneBucketId !== null && page.parent_page_id === doneBucketId;
  const isActive = activeTask !== null;
  // Stash where the row was BEFORE it got moved to done so toggling back
  // returns it to its previous bucket. We only need this when the row is
  // already done — for everything else, "uncheck" doesn't make sense.
  const [previousParent, setPreviousParent] = useState<string | null>(null);

  async function toggle() {
    if (!doneBucketId) return;
    const db = await getDatabase();
    const doc = await db.collections.wiki_pages.findOne(page.id).exec();
    if (!doc) return;
    if (isDone) {
      const target = previousParent ?? page.parent_page_id;
      if (!target) return;
      await doc.patch({
        parent_page_id: target,
        updated_at: new Date().toISOString(),
      });
    } else {
      setPreviousParent(page.parent_page_id);
      await doc.patch({
        parent_page_id: doneBucketId,
        updated_at: new Date().toISOString(),
      });
    }
  }

  return (
    <View style={[styles.row, isActive && styles.rowActive]}>
      {isActive ? (
        <View style={styles.activeSpinner}>
          <ActivityIndicator color="#4d8fdb" />
        </View>
      ) : (
        <Pressable onPress={toggle} hitSlop={10} style={styles.checkbox}>
          <View style={[styles.checkboxInner, isDone && styles.checkboxInnerDone]}>
            {isDone ? <Ionicons name="checkmark" size={14} color="#0a1628" /> : null}
          </View>
        </Pressable>
      )}
      <Pressable style={styles.rowMain} onPress={onOpen}>
        <Text style={[styles.rowTitle, isDone && styles.rowTitleDone]} numberOfLines={2}>
          {page.title}
        </Text>
        <Text style={styles.rowAbstract} numberOfLines={2}>
          {isActive
            ? activeTask?.status === 'running'
              ? `Researching now · usually 1–3 min`
              : 'Queued for research'
            : page.agent_abstract}
        </Text>
      </Pressable>
      <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
    </View>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

function DetailScreen({ navigation, route }: NativeStackScreenProps<TodosStackParamList, 'Detail'>) {
  const pages = useWikiPages();
  const page = pages.find((p) => p.id === route.params.pageId);

  if (!page) {
    return (
      <View style={styles.flex}>
        <PluginBackRow label="Todos" onPress={() => navigation.goBack()} />
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Todo not found.</Text>
        </View>
      </View>
    );
  }

  return <WikiPageDetail page={page} onBack={() => navigation.goBack()} />;
}

// ── Create ──────────────────────────────────────────────────────────────────

function CreateScreen({ navigation }: NativeStackScreenProps<TodosStackParamList, 'Create'>) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = title.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await spawnTodo({ title: trimmed, content: content.trim() || undefined });
      navigation.goBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <PluginBackRow label="Todos" onPress={() => navigation.goBack()} />
      <View style={styles.createBody}>
        <Text style={styles.createTitle}>New todo</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="What needs doing?"
          placeholderTextColor="#3f5a83"
          style={styles.titleInput}
          autoFocus
        />
        <TextInput
          value={content}
          onChangeText={setContent}
          placeholder="Notes (optional)…"
          placeholderTextColor="#3f5a83"
          style={styles.contentInput}
          multiline
        />
        {error && (
          <Text style={styles.errorText} numberOfLines={3}>
            {error}
          </Text>
        )}
        <Pressable
          onPress={submit}
          disabled={submitting || title.trim().length === 0}
          style={[
            styles.submitButton,
            (submitting || title.trim().length === 0) && { opacity: 0.4 },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.submitButtonLabel}>Add todo</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#7aa3d4' },
  list: { paddingVertical: 4 },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#7aa3d4', fontSize: 14, textAlign: 'center' },

  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'transparent',
  },
  tabActive: { backgroundColor: '#11203a' },
  tabLabel: { color: '#7aa3d4', fontSize: 13, fontWeight: '500' },
  tabLabelActive: { color: '#e8f1ff' },
  tabCount: {
    color: '#3f5a83',
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 6,
    borderRadius: 8,
    backgroundColor: '#0a1628',
    overflow: 'hidden',
  },
  tabCountActive: { color: '#7aa3d4' },

  createRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  createRowLabel: { color: '#4d8fdb', fontSize: 15, fontWeight: '500' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  rowActive: { backgroundColor: '#0e1c30' },
  activeSpinner: { width: 28, alignItems: 'center', justifyContent: 'center' },
  checkbox: { padding: 4 },
  checkboxInner: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#3f5a83',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxInnerDone: { backgroundColor: '#4d8fdb', borderColor: '#4d8fdb' },
  rowMain: { flex: 1, gap: 4 },
  rowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '500' },
  rowTitleDone: { color: '#7aa3d4', textDecorationLine: 'line-through' },
  rowAbstract: { color: '#7aa3d4', fontSize: 12, lineHeight: 16 },

  createBody: { padding: 16, gap: 12, flex: 1 },
  createTitle: { color: '#e8f1ff', fontSize: 18, fontWeight: '600' },
  titleInput: {
    color: '#e8f1ff',
    fontSize: 17,
    fontWeight: '500',
    backgroundColor: '#11203a',
    borderRadius: 8,
    padding: 12,
  },
  contentInput: {
    color: '#cbd9eb',
    fontSize: 14,
    lineHeight: 20,
    backgroundColor: '#11203a',
    borderRadius: 8,
    padding: 12,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  submitButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#4d8fdb',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 6,
    minWidth: 120,
    alignItems: 'center',
  },
  submitButtonLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  errorText: { color: '#f87171', fontSize: 12 },
});
