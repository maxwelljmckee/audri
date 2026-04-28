// Research plugin's stack navigation. Three screens: list, spawn, detail.

import { Ionicons } from '@expo/vector-icons';
import {
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import { useState } from 'react';
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
import type { AgentTaskDoc, ResearchOutputDoc } from '../../lib/rxdb/schemas';
import { useActiveAgentTasks } from '../../lib/rxdb/useAgentTasks';
import { useResearchOutputs } from '../../lib/rxdb/useResearchOutputs';
import { useRxdbReady } from '../../lib/rxdb/useRxdbReady';
import { spawnResearch } from '../../lib/spawnResearch';
import { PluginBackRow, pluginStackScreenOptions } from '../PluginStack';
import { ResearchOutputDetail } from '../ResearchOutputDetail';

export type ResearchStackParamList = {
  List: undefined;
  Spawn: undefined;
  Detail: { researchOutputId: string };
};

const Stack = createNativeStackNavigator<ResearchStackParamList>();

export function ResearchStack() {
  return (
    <Stack.Navigator screenOptions={pluginStackScreenOptions} initialRouteName="List">
      <Stack.Screen name="List" component={ListScreen} />
      <Stack.Screen name="Spawn" component={SpawnScreen} />
      <Stack.Screen name="Detail" component={DetailScreen} />
    </Stack.Navigator>
  );
}

// Discriminated row data so a single FlatList can render both pending tasks
// (queued/running, no artifact yet) and completed outputs without two parallel
// lists (which would each have their own scrolling region — bad UX).
type RowData =
  | { kind: 'pending'; task: AgentTaskDoc }
  | { kind: 'output'; output: ResearchOutputDoc };

function ListScreen({ navigation }: NativeStackScreenProps<ResearchStackParamList, 'List'>) {
  const ready = useRxdbReady();
  const outputs = useResearchOutputs();
  const pendingTasks = useActiveAgentTasks('research');

  if (!ready) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Syncing…</Text>
      </View>
    );
  }

  // Pending rows always pin to the top so users can see queued work without
  // scrolling. Once a task succeeds it falls out of pendingTasks (terminal
  // statuses excluded) and the matching research_output appears in `outputs`.
  const rows: RowData[] = [
    ...pendingTasks.map((task) => ({ kind: 'pending' as const, task })),
    ...outputs.map((output) => ({ kind: 'output' as const, output })),
  ];

  return (
    <View style={styles.flex}>
      <Pressable style={styles.spawnRow} onPress={() => navigation.push('Spawn')}>
        <Ionicons name="add-circle-outline" size={22} color="#4d8fdb" />
        <Text style={styles.spawnRowLabel}>New research</Text>
      </Pressable>
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'pending' ? `task:${r.task.id}` : `out:${r.output.id}`)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              No research yet. Tap "New research" or ask Audri to look something up mid-call.
            </Text>
          </View>
        }
        renderItem={({ item }) =>
          item.kind === 'pending' ? (
            <PendingRow task={item.task} />
          ) : (
            <Pressable
              style={styles.row}
              onPress={() => navigation.push('Detail', { researchOutputId: item.output.id })}
            >
              <View style={styles.rowMain}>
                <Text style={styles.rowTitle} numberOfLines={2}>
                  {item.output.title || item.output.query}
                </Text>
                <Text style={styles.rowQuery} numberOfLines={2}>
                  {item.output.query}
                </Text>
                <Text style={styles.rowMeta}>
                  {new Date(item.output.generated_at).toLocaleDateString()} ·{' '}
                  {item.output.findings.length} finding
                  {item.output.findings.length === 1 ? '' : 's'} · {item.output.citations.length}{' '}
                  source{item.output.citations.length === 1 ? '' : 's'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
            </Pressable>
          )
        }
      />
    </View>
  );
}

function PendingRow({ task }: { task: AgentTaskDoc }) {
  const query =
    typeof task.payload?.query === 'string' ? (task.payload.query as string) : '(unknown)';
  const label = task.status === 'running' ? 'Researching now' : 'Queued';
  return (
    <View style={[styles.row, styles.pendingRow]}>
      <View style={styles.pendingSpinner}>
        <ActivityIndicator color="#4d8fdb" />
      </View>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {query}
        </Text>
        <Text style={styles.rowMeta}>{label} · usually 1–3 min</Text>
      </View>
    </View>
  );
}

function SpawnScreen({ navigation }: NativeStackScreenProps<ResearchStackParamList, 'Spawn'>) {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await spawnResearch(trimmed);
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
      <PluginBackRow label="Research" onPress={() => navigation.goBack()} />
      <View style={styles.spawnBody}>
        <Text style={styles.spawnTitle}>What should I research?</Text>
        <Text style={styles.spawnHint}>
          Be specific. Good prompts include the question + any constraints (location, timeframe,
          depth).
        </Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="e.g. Italian restaurants in lower Manhattan with outdoor seating"
          placeholderTextColor="#3f5a83"
          style={styles.spawnInput}
          multiline
          autoFocus
        />
        {error && (
          <Text style={styles.errorText} numberOfLines={3}>
            {error}
          </Text>
        )}
        <Pressable
          onPress={submit}
          disabled={submitting || query.trim().length === 0}
          style={[
            styles.spawnButton,
            (submitting || query.trim().length === 0) && { opacity: 0.4 },
          ]}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.spawnButtonLabel}>Start research</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function DetailScreen({ navigation, route }: NativeStackScreenProps<ResearchStackParamList, 'Detail'>) {
  const outputs = useResearchOutputs();
  const output = outputs.find((o) => o.id === route.params.researchOutputId);

  if (!output) {
    return (
      <View style={styles.flex}>
        <PluginBackRow label="Research" onPress={() => navigation.goBack()} />
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Research output not found.</Text>
        </View>
      </View>
    );
  }

  return <ResearchOutputDetail output={output} onBack={() => navigation.goBack()} />;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#7aa3d4' },
  list: { paddingVertical: 4 },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#7aa3d4', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  spawnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  spawnRowLabel: { color: '#4d8fdb', fontSize: 15, fontWeight: '500' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  rowMain: { flex: 1, gap: 3 },
  rowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '600' },
  rowQuery: { color: '#7aa3d4', fontSize: 12, lineHeight: 16, fontStyle: 'italic' },
  rowMeta: { color: '#7aa3d4', fontSize: 12, marginTop: 2 },
  pendingRow: { backgroundColor: '#0e1c30' },
  pendingSpinner: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  spawnBody: { padding: 16, gap: 12, flex: 1 },
  spawnTitle: { color: '#e8f1ff', fontSize: 18, fontWeight: '600' },
  spawnHint: { color: '#7aa3d4', fontSize: 13, lineHeight: 18 },
  spawnInput: {
    color: '#e8f1ff',
    fontSize: 15,
    lineHeight: 22,
    backgroundColor: '#11203a',
    borderRadius: 8,
    padding: 12,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  spawnButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#4d8fdb',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 6,
    minWidth: 140,
    alignItems: 'center',
  },
  spawnButtonLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  errorText: { color: '#f87171', fontSize: 12 },
});
