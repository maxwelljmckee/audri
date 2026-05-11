// Todos plugin's stack navigation. v0.2.1 sidecar refactor (2026-05-10):
//
// Status no longer encodes as wiki hierarchy; the `todos` sidecar table
// owns lifecycle. Two-axis UX:
//
//   - **Horizontal (top tab strip):** filter by status — To do / In progress
//     / Done / Archived. Default tab is "To do."
//   - **Vertical (within the active tab):** todos grouped into collapsible
//     swimlanes by `parent_page_id` association — "General" (NULL parent)
//     plus one swimlane per associated wiki page (project / goal / person /
//     etc.). Within a swimlane, todos render newest-first.
//
// Wiki layer: type='todo' wiki rows still exist as ingestion + agent-task
// triggering shells (hidden from Notes UI). The sidecar drives the UX.

import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import {
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { AgentTaskDoc, TodoDoc, WikiPageDoc } from '../../lib/rxdb/schemas';
import { useActiveAgentTasks } from '../../lib/rxdb/useAgentTasks';
import { useReplicationResync } from '../../lib/rxdb/useReplicationResync';
import { useRxdbReady } from '../../lib/rxdb/useRxdbReady';
import { updateTodoStatus, useTodos } from '../../lib/rxdb/useTodos';
import { useWikiPages } from '../../lib/rxdb/useWikiPages';
import { spawnTodo } from '../../lib/spawnTodo';
import { PluginBackRow, pluginStackScreenOptions } from '../PluginStack';
import { ResyncControl } from '../ResyncControl';
import { WikiPageDetail } from '../WikiPageDetail';

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

// ── Swimlane list ──────────────────────────────────────────────────────────

interface Swimlane {
  // null parentPageId → "General" lane (no wiki page association).
  parentPageId: string | null;
  parentTitle: string;
  // All todos for this lane, already filtered to the active status; sorted
  // newest-first within the lane.
  todos: TodoDoc[];
}

const STATUS_TABS: { slug: TodoDoc['status']; label: string }[] = [
  { slug: 'todo', label: 'To do' },
  { slug: 'in-progress', label: 'In progress' },
  { slug: 'done', label: 'Done' },
  { slug: 'archived', label: 'Archived' },
];

// Group an already-status-filtered todo list into swimlanes by parent_page_id.
// "General" (NULL parent) lane sorts first; named lanes follow alphabetically.
function buildSwimlanes(todos: TodoDoc[], pages: WikiPageDoc[]): Swimlane[] {
  const titleByPageId = new Map<string, string>();
  for (const p of pages) titleByPageId.set(p.id, p.title);

  const byParent = new Map<string | null, TodoDoc[]>();
  for (const t of todos) {
    const key = t.parent_page_id ?? null;
    const list = byParent.get(key) ?? [];
    list.push(t);
    byParent.set(key, list);
  }

  const sortLane = (list: TodoDoc[]): TodoDoc[] =>
    [...list].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

  const lanes: Swimlane[] = [];
  const general = byParent.get(null);
  if (general && general.length > 0) {
    lanes.push({ parentPageId: null, parentTitle: 'General', todos: sortLane(general) });
  }
  const named: Swimlane[] = [];
  for (const [parentId, list] of byParent.entries()) {
    if (parentId === null) continue;
    named.push({
      parentPageId: parentId,
      parentTitle: titleByPageId.get(parentId) ?? '(unknown)',
      todos: sortLane(list),
    });
  }
  named.sort((a, b) => a.parentTitle.localeCompare(b.parentTitle));
  lanes.push(...named);
  return lanes;
}

function ListScreen({ navigation }: NativeStackScreenProps<TodosStackParamList, 'List'>) {
  const ready = useRxdbReady();
  const allTodos = useTodos();
  const pages = useWikiPages();
  const activeResearch = useActiveAgentTasks('research');
  const { refreshing, onRefresh } = useReplicationResync();

  // Active status tab — horizontal axis. Defaults to "To do" since that's
  // the user's most-frequent landing context. The tab strip shows counts
  // per status so the user knows what's queued elsewhere.
  const [activeStatus, setActiveStatus] = useState<TodoDoc['status']>('todo');

  // Counts per status for the tab strip badges.
  const countByStatus = useMemo(() => {
    const m: Record<TodoDoc['status'], number> = {
      todo: 0,
      'in-progress': 0,
      done: 0,
      archived: 0,
    };
    for (const t of allTodos) m[t.status]++;
    return m;
  }, [allTodos]);

  // Map pageId → in-flight research task so each row can render the spinner
  // + "Researching now…" indicator without each row subscribing.
  const activeByPageId = useMemo(() => {
    const m = new Map<string, AgentTaskDoc>();
    for (const t of activeResearch) m.set(t.todo_page_id, t);
    return m;
  }, [activeResearch]);

  // Page lookup by id for per-row title display.
  const titleByPageId = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pages) m.set(p.id, p.title);
    return m;
  }, [pages]);

  // Swimlanes — filtered to the active status, then grouped by parent_page_id.
  const swimlanes = useMemo(() => {
    const filtered = allTodos.filter((t) => t.status === activeStatus);
    return buildSwimlanes(filtered, pages);
  }, [allTodos, pages, activeStatus]);

  // Per-lane collapsed state. Lanes default OPEN. Component-memory only;
  // V1+ can move to AsyncStorage if state-across-reloads becomes desirable.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  function toggleCollapsed(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (!ready) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Syncing…</Text>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      {/* Status tab strip — horizontal axis. */}
      <View style={styles.tabBar}>
        {STATUS_TABS.map((tab) => {
          const isActive = tab.slug === activeStatus;
          const count = countByStatus[tab.slug];
          return (
            <Pressable
              key={tab.slug}
              style={[styles.tab, isActive && styles.tabActive]}
              onPress={() => setActiveStatus(tab.slug)}
            >
              <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{tab.label}</Text>
              {count > 0 ? (
                <Text style={[styles.tabCount, isActive && styles.tabCountActive]}>{count}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <Pressable style={styles.createRow} onPress={() => navigation.push('Create')}>
        <Ionicons name="add-circle-outline" size={22} color="#4d8fdb" />
        <Text style={styles.createRowLabel}>New todo</Text>
      </Pressable>

      <ScrollView
        contentContainerStyle={styles.list}
        refreshControl={<ResyncControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {swimlanes.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {activeStatus === 'todo'
                ? 'No todos yet. Tap "New todo" to add one.'
                : `No ${STATUS_TABS.find((t) => t.slug === activeStatus)?.label.toLowerCase()} todos.`}
            </Text>
          </View>
        )}
        {swimlanes.map((lane) => {
          const key = lane.parentPageId ?? '__general__';
          const isCollapsed = collapsed.has(key);
          return (
            <View key={key} style={styles.lane}>
              <Pressable style={styles.laneHeader} onPress={() => toggleCollapsed(key)}>
                <Ionicons
                  name={isCollapsed ? 'chevron-forward' : 'chevron-down'}
                  size={16}
                  color="#7aa3d4"
                />
                <Text style={styles.laneTitle} numberOfLines={1}>
                  {lane.parentTitle}
                </Text>
                <Text style={styles.laneCount}>{lane.todos.length}</Text>
              </Pressable>
              {!isCollapsed &&
                lane.todos.map((t) => (
                  <TodoRow
                    key={t.id}
                    todo={t}
                    pageTitle={titleByPageId.get(t.page_id) ?? '(unknown)'}
                    activeTask={activeByPageId.get(t.page_id) ?? null}
                    onOpen={() => navigation.push('Detail', { pageId: t.page_id })}
                  />
                ))}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function TodoRow({
  todo,
  pageTitle,
  activeTask,
  onOpen,
}: {
  todo: TodoDoc;
  pageTitle: string;
  activeTask: AgentTaskDoc | null;
  onOpen: () => void;
}) {
  const isDone = todo.status === 'done' || todo.status === 'archived';
  const isActive = activeTask !== null;

  async function toggle() {
    if (isActive) return;
    const next: TodoDoc['status'] = isDone ? 'todo' : 'done';
    await updateTodoStatus(todo.id, next);
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
          {pageTitle}
        </Text>
        {isActive ? (
          <Text style={styles.rowAbstract} numberOfLines={1}>
            {activeTask?.status === 'running'
              ? 'Researching now · usually 1–3 min'
              : 'Queued for research'}
          </Text>
        ) : todo.status === 'in-progress' ? (
          <Text style={styles.rowStatus}>In progress</Text>
        ) : null}
      </Pressable>
      <AssigneeAvatar agentId={todo.assignee_agent_id} />
      <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
    </View>
  );
}

// Right-aligned avatar indicating who owns the todo. The data-model default
// is user-ownership — `assignee_agent_id` is NULL unless ingestion or a
// manual flow explicitly set it. We render the user icon for both `null`
// AND `undefined` (the field is undefined on rows that pre-date migration
// 0021); the robot icon ONLY shows when the column carries a real agent
// uuid. Visual-only — clicking the row still opens the detail view.
function AssigneeAvatar({ agentId }: { agentId: string | null | undefined }) {
  const isAgent = typeof agentId === 'string' && agentId.length > 0;
  return (
    <View style={styles.assigneeAvatar}>
      {isAgent ? (
        <MaterialCommunityIcons name="robot" size={16} color="#7aa3d4" />
      ) : (
        <Ionicons name="person" size={14} color="#7aa3d4" />
      )}
    </View>
  );
}

// ── Detail ─────────────────────────────────────────────────────────────────

function DetailScreen({
  navigation,
  route,
}: NativeStackScreenProps<TodosStackParamList, 'Detail'>) {
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

// ── Create ─────────────────────────────────────────────────────────────────

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
          style={styles.createInput}
          autoFocus
        />
        <TextInput
          value={content}
          onChangeText={setContent}
          placeholder="Notes (optional)"
          placeholderTextColor="#3f5a83"
          style={[styles.createInput, styles.createNotes]}
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
            styles.createButton,
            (submitting || title.trim().length === 0) && { opacity: 0.4 },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.createButtonLabel}>Add todo</Text>
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
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#7aa3d4', fontSize: 14, textAlign: 'center', lineHeight: 20 },

  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  tabActive: { backgroundColor: '#11203a' },
  tabLabel: { color: '#7aa3d4', fontSize: 13, fontWeight: '500' },
  tabLabelActive: { color: '#e8f1ff', fontWeight: '600' },
  tabCount: {
    color: '#7aa3d4',
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: '#0e1c30',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
    overflow: 'hidden',
    minWidth: 18,
    textAlign: 'center',
  },
  tabCountActive: { color: '#e8f1ff', backgroundColor: '#1f3a66' },

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

  list: { paddingVertical: 4 },

  lane: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
    paddingBottom: 4,
  },
  laneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  laneTitle: {
    flex: 1,
    color: '#e8f1ff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  laneCount: {
    color: '#7aa3d4',
    fontSize: 12,
    fontWeight: '500',
    minWidth: 18,
    textAlign: 'right',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  rowActive: { backgroundColor: '#0e1c30' },
  checkbox: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  checkboxInner: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: '#4d8fdb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxInnerDone: {
    backgroundColor: '#4d8fdb',
    borderColor: '#4d8fdb',
  },
  activeSpinner: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowMain: { flex: 1, gap: 2 },
  rowTitle: { color: '#e8f1ff', fontSize: 15 },
  rowTitleDone: { color: '#7aa3d4', textDecorationLine: 'line-through' },
  rowAbstract: { color: '#7aa3d4', fontSize: 12 },
  rowStatus: { color: '#4d8fdb', fontSize: 11, fontWeight: '600' },
  // Subtle owner indicator. Bg is a muted tint of the accent so the avatar
  // reads as low-priority context, not a primary action.
  assigneeAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#11203a',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
  },

  createBody: { padding: 16, gap: 12, flex: 1 },
  createTitle: { color: '#e8f1ff', fontSize: 18, fontWeight: '600' },
  createInput: {
    color: '#e8f1ff',
    fontSize: 15,
    backgroundColor: '#11203a',
    borderRadius: 8,
    padding: 12,
  },
  createNotes: { minHeight: 100, textAlignVertical: 'top' },
  createButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#4d8fdb',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 6,
    minWidth: 140,
    alignItems: 'center',
  },
  createButtonLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  errorText: { color: '#f87171', fontSize: 12 },
});
