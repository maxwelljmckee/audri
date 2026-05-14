// Automations plugin stack. Two tabs on List (Suggested / Active) +
// Detail screen for editing schedule, pausing, deleting an active row.

import { Ionicons } from '@expo/vector-icons';
import type { AutomationKindMeta } from '@audri/shared/automations';
import {
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  type AutomationRow,
  deleteAutomation,
  instantiateAutomation,
  patchAutomation,
} from '../../lib/automations/api';
import {
  useActiveAutomations,
  useSuggestedAutomations,
} from '../../lib/automations/useAutomations';
import { PluginBackRow, pluginStackScreenOptions } from '../PluginStack';

export type AutomationsStackParamList = {
  List: undefined;
  Detail: { automationId: string };
};

const Stack = createNativeStackNavigator<AutomationsStackParamList>();

export function AutomationsStack() {
  return (
    <Stack.Navigator screenOptions={pluginStackScreenOptions} initialRouteName="List">
      <Stack.Screen name="List" component={ListScreen} />
      <Stack.Screen name="Detail" component={DetailScreen} />
    </Stack.Navigator>
  );
}

// ── List screen with Suggested / Active tabs ─────────────────────────────

type Tab = 'suggested' | 'active';

function ListScreen({ navigation }: NativeStackScreenProps<AutomationsStackParamList, 'List'>) {
  const [tab, setTab] = useState<Tab>('suggested');
  const suggested = useSuggestedAutomations();
  const active = useActiveAutomations();

  // Map of active rows keyed by (kind|suggested_id) → row. Lets the
  // Suggested tab show "already on" instead of a toggle when a row
  // exists for that combination.
  const activeBySuggestion = useMemo(() => {
    const m = new Map<string, AutomationRow>();
    for (const row of active.data ?? []) {
      if (row.suggested_id) m.set(`${row.kind}|${row.suggested_id}`, row);
    }
    return m;
  }, [active.data]);

  const onToggleSuggested = useCallback(
    async (kind: string, suggestedId: string) => {
      const existing = activeBySuggestion.get(`${kind}|${suggestedId}`);
      try {
        if (existing) {
          // Already active — tombstone it.
          await deleteAutomation(existing.id);
        } else {
          await instantiateAutomation({ kind, suggestedId });
        }
        await active.refresh();
      } catch (e) {
        Alert.alert('Couldn’t change automation', e instanceof Error ? e.message : String(e));
      }
    },
    [active, activeBySuggestion],
  );

  const onTogglePause = useCallback(
    async (row: AutomationRow) => {
      try {
        await patchAutomation(row.id, { paused: !row.paused });
        await active.refresh();
      } catch (e) {
        Alert.alert('Couldn’t change automation', e instanceof Error ? e.message : String(e));
      }
    },
    [active],
  );

  return (
    <View style={styles.flex}>
      <View style={styles.tabBar}>
        <TabButton label="Suggested" selected={tab === 'suggested'} onPress={() => setTab('suggested')} />
        <TabButton label="Active" selected={tab === 'active'} onPress={() => setTab('active')} />
      </View>
      {tab === 'suggested' ? (
        <SuggestedTab
          catalog={suggested.data}
          loading={suggested.loading}
          error={suggested.error}
          activeBySuggestion={activeBySuggestion}
          onToggle={onToggleSuggested}
          onRefresh={async () => {
            await Promise.all([suggested.refresh(), active.refresh()]);
          }}
        />
      ) : (
        <ActiveTab
          rows={active.data}
          loading={active.loading}
          error={active.error}
          onRefresh={async () => {
            await active.refresh();
          }}
          onTogglePause={onTogglePause}
          onOpen={(row) => navigation.push('Detail', { automationId: row.id })}
        />
      )}
    </View>
  );
}

function TabButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, selected && styles.tabSelected]}>
      <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

// ── Suggested tab — catalog grouped by kind ──────────────────────────────

function SuggestedTab({
  catalog,
  loading,
  error,
  activeBySuggestion,
  onToggle,
  onRefresh,
}: {
  catalog: AutomationKindMeta[] | null;
  loading: boolean;
  error: string | null;
  activeBySuggestion: Map<string, AutomationRow>;
  onToggle: (kind: string, suggestedId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  if (loading && !catalog) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#4d8fdb" />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.empty}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable onPress={() => void onRefresh()} style={styles.retryButton}>
          <Text style={styles.retryButtonLabel}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (!catalog || catalog.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No suggestions available yet.</Text>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      {catalog.map((meta) => (
        <View key={meta.kind} style={styles.section}>
          <Text style={styles.sectionHeader}>{meta.label}</Text>
          <Text style={styles.sectionBlurb}>{meta.capabilityBlurb}</Text>
          {meta.suggested.map((s) => {
            const existing = activeBySuggestion.get(`${meta.kind}|${s.id}`);
            const isActive = !!existing;
            return (
              <View key={s.id} style={styles.suggestedRow}>
                <View style={styles.suggestedRowMain}>
                  <Text style={styles.suggestedRowTitle}>{s.name}</Text>
                  <Text style={styles.suggestedRowDescription}>{s.description}</Text>
                  <Text style={styles.suggestedRowSchedule}>
                    {scheduleSummary(s.defaultSchedule.daysOfWeek, s.defaultSchedule.times)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => void onToggle(meta.kind, s.id)}
                  style={[styles.toggleButton, isActive && styles.toggleButtonOn]}
                >
                  <Text style={[styles.toggleLabel, isActive && styles.toggleLabelOn]}>
                    {isActive ? 'On' : 'Off'}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

// ── Active tab — instantiated rows ───────────────────────────────────────

function ActiveTab({
  rows,
  loading,
  error,
  onRefresh,
  onTogglePause,
  onOpen,
}: {
  rows: AutomationRow[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onTogglePause: (row: AutomationRow) => Promise<void>;
  onOpen: (row: AutomationRow) => void;
}) {
  if (loading && !rows) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#4d8fdb" />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.empty}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable onPress={() => void onRefresh()} style={styles.retryButton}>
          <Text style={styles.retryButtonLabel}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          No active automations yet. Browse the Suggested tab to turn one on.
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <Pressable style={styles.row} onPress={() => onOpen(item)}>
          <View style={styles.rowMain}>
            <Text style={styles.rowTitle}>{rowDisplayTitle(item)}</Text>
            <Text style={styles.rowMeta}>
              {scheduleSummary(item.days_of_week, item.times)} · {item.timezone}
            </Text>
            <Text style={styles.rowMeta}>
              Next run: {formatTimestamp(item.next_run_at, item.paused)} · Last run:{' '}
              {formatTimestamp(item.last_run_at, false)}
            </Text>
          </View>
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              void onTogglePause(item);
            }}
            style={[styles.pauseButton, item.paused && styles.pauseButtonPaused]}
          >
            <Ionicons
              name={item.paused ? 'play' : 'pause'}
              size={16}
              color={item.paused ? '#0a1628' : '#e8f1ff'}
            />
          </Pressable>
          <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
        </Pressable>
      )}
    />
  );
}

// ── Detail screen — edit / delete ────────────────────────────────────────

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface TimeEntry {
  id: number;
  value: string;
}

function DetailScreen({
  navigation,
  route,
}: NativeStackScreenProps<AutomationsStackParamList, 'Detail'>) {
  const { data: rows, refresh } = useActiveAutomations();
  const row = rows?.find((r) => r.id === route.params.automationId);

  // Local edit state. Time entries carry stable ids so list-renders
  // don't rely on array index (rejected by biome's noArrayIndexKey).
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const nextTimeId = useRef(0);

  const makeEntries = useCallback((values: string[]): TimeEntry[] => {
    return values.map((value) => ({ id: nextTimeId.current++, value }));
  }, []);

  // Sync local state from server row. Effect re-runs whenever the row
  // object reference changes (initial mount, refresh) but the `dirty`
  // guard prevents clobbering in-progress edits. After a save we flip
  // dirty back to false, which intentionally re-runs this effect with
  // the freshly-saved row data.
  useEffect(() => {
    if (!row) return;
    if (dirty) return;
    setDaysOfWeek(row.days_of_week);
    setTimeEntries(makeEntries(row.times));
  }, [row, dirty, makeEntries]);

  if (!row) {
    return (
      <View style={styles.flex}>
        <PluginBackRow label="Automations" onPress={() => navigation.goBack()} />
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Automation not found.</Text>
        </View>
      </View>
    );
  }

  const toggleDay = (dow: number) => {
    setDaysOfWeek((prev) =>
      prev.includes(dow) ? prev.filter((d) => d !== dow) : [...prev, dow].sort(),
    );
    setDirty(true);
  };

  const cycleTime = (entryId: number, deltaMinutes: number) => {
    setTimeEntries((prev) =>
      prev.map((e) => (e.id === entryId ? { ...e, value: shiftHHMM(e.value, deltaMinutes) } : e)),
    );
    setDirty(true);
  };

  const addTime = () => {
    setTimeEntries((prev) => [...prev, { id: nextTimeId.current++, value: '12:00' }]);
    setDirty(true);
  };
  const removeTime = (entryId: number) => {
    setTimeEntries((prev) => prev.filter((e) => e.id !== entryId));
    setDirty(true);
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await patchAutomation(row.id, {
        daysOfWeek,
        times: timeEntries.map((e) => e.value),
      });
      await refresh();
      setDirty(false);
    } catch (e) {
      Alert.alert('Couldn’t save', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = () => {
    Alert.alert('Delete automation?', 'This stops future runs. Past output is preserved.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteAutomation(row.id);
            await refresh();
            navigation.goBack();
          } catch (e) {
            Alert.alert('Couldn’t delete', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Automations" onPress={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={styles.detailContent}>
        <Text style={styles.detailTitle}>{rowDisplayTitle(row)}</Text>
        <Text style={styles.detailMeta}>
          Status: {row.paused ? 'Paused' : 'Active'} · {row.timezone}
        </Text>
        <Text style={styles.detailMeta}>Next run: {formatTimestamp(row.next_run_at, row.paused)}</Text>
        <Text style={styles.detailMeta}>Last run: {formatTimestamp(row.last_run_at, false)}</Text>

        <Text style={styles.detailSectionHeader}>Days of week</Text>
        <Text style={styles.detailHint}>Leave all unchecked to run every day.</Text>
        <View style={styles.dayRow}>
          {DAY_LABELS.map((label, dow) => {
            const on = daysOfWeek.includes(dow);
            return (
              <Pressable
                key={label}
                onPress={() => toggleDay(dow)}
                style={[styles.dayChip, on && styles.dayChipOn]}
              >
                <Text style={[styles.dayChipLabel, on && styles.dayChipLabelOn]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.detailSectionHeader}>Times of day</Text>
        <Text style={styles.detailHint}>
          Tap ± to adjust by 30 minutes. Add multiple fires per day if you need them.
        </Text>
        {timeEntries.map((entry) => (
          <View key={entry.id} style={styles.timeRow}>
            <Pressable style={styles.timeStep} onPress={() => cycleTime(entry.id, -30)}>
              <Text style={styles.timeStepLabel}>−</Text>
            </Pressable>
            <Text style={styles.timeValue}>{entry.value}</Text>
            <Pressable style={styles.timeStep} onPress={() => cycleTime(entry.id, 30)}>
              <Text style={styles.timeStepLabel}>+</Text>
            </Pressable>
            {timeEntries.length > 1 && (
              <Pressable style={styles.timeRemove} onPress={() => removeTime(entry.id)}>
                <Ionicons name="close" size={16} color="#7aa3d4" />
              </Pressable>
            )}
          </View>
        ))}
        <Pressable style={styles.addTimeRow} onPress={addTime}>
          <Ionicons name="add" size={18} color="#4d8fdb" />
          <Text style={styles.addTimeLabel}>Add another time</Text>
        </Pressable>

        <View style={styles.actionRow}>
          <Pressable
            style={[styles.primaryButton, (!dirty || saving) && { opacity: 0.4 }]}
            disabled={!dirty || saving}
            onPress={() => void onSave()}
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryButtonLabel}>Save changes</Text>
            )}
          </Pressable>
          <Pressable style={styles.destructiveButton} onPress={onDelete}>
            <Text style={styles.destructiveButtonLabel}>Delete</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function rowDisplayTitle(row: AutomationRow): string {
  // Best-effort label. suggested_id is the canonical name, kind is a fallback.
  if (row.suggested_id) {
    return prettifyId(row.suggested_id);
  }
  return prettifyId(row.kind);
}

function prettifyId(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => (w.length === 0 ? '' : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

function scheduleSummary(daysOfWeek: number[], times: string[]): string {
  const dayPart = daysOfWeek.length === 0 ? 'Every day' : daysOfWeek.map((d) => DAY_LABELS[d]).join(' ');
  const timePart = times.length === 0 ? 'No times set' : times.join(', ');
  return `${dayPart} at ${timePart}`;
}

function formatTimestamp(iso: string | null, paused: boolean): string {
  if (paused) return 'Paused';
  if (!iso) return 'Never';
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .toLowerCase()}`;
}

function shiftHHMM(hhmm: string, deltaMinutes: number): string {
  const [hStr, mStr] = hhmm.split(':');
  let total = (Number(hStr) * 60 + Number(mStr) + deltaMinutes) % (24 * 60);
  if (total < 0) total += 24 * 60;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ── Styles ───────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { padding: 24, alignItems: 'center', gap: 12 },
  emptyText: { color: '#7aa3d4', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  errorText: { color: '#f87171', fontSize: 13, textAlign: 'center' },
  retryButton: {
    backgroundColor: '#11203a',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
  },
  retryButtonLabel: { color: '#e8f1ff', fontSize: 13 },

  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabSelected: { borderBottomWidth: 2, borderBottomColor: '#4d8fdb' },
  tabLabel: { color: '#7aa3d4', fontSize: 14, fontWeight: '500' },
  tabLabelSelected: { color: '#e8f1ff', fontWeight: '600' },

  scrollContent: { paddingBottom: 40 },
  section: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 8 },
  sectionHeader: { color: '#e8f1ff', fontSize: 16, fontWeight: '600' },
  sectionBlurb: { color: '#7aa3d4', fontSize: 13, lineHeight: 18, marginTop: 4 },

  suggestedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1f2f4d',
    marginTop: 12,
  },
  suggestedRowMain: { flex: 1, gap: 3 },
  suggestedRowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '600' },
  suggestedRowDescription: { color: '#7aa3d4', fontSize: 13, lineHeight: 18 },
  suggestedRowSchedule: { color: '#4d8fdb', fontSize: 12, marginTop: 2 },

  toggleButton: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: '#11203a',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1f2f4d',
    minWidth: 56,
    alignItems: 'center',
  },
  toggleButtonOn: { backgroundColor: '#4d8fdb', borderColor: '#4d8fdb' },
  toggleLabel: { color: '#7aa3d4', fontSize: 12, fontWeight: '600' },
  toggleLabelOn: { color: '#fff' },

  list: { paddingVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  rowMain: { flex: 1, gap: 3 },
  rowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '600' },
  rowMeta: { color: '#7aa3d4', fontSize: 12, lineHeight: 16 },
  pauseButton: {
    backgroundColor: '#11203a',
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pauseButtonPaused: { backgroundColor: '#4d8fdb' },

  detailContent: { padding: 16, gap: 8, paddingBottom: 40 },
  detailTitle: { color: '#e8f1ff', fontSize: 20, fontWeight: '700' },
  detailMeta: { color: '#7aa3d4', fontSize: 13 },
  detailSectionHeader: {
    color: '#e8f1ff',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 18,
  },
  detailHint: { color: '#7aa3d4', fontSize: 12 },

  dayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  dayChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: '#11203a',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#1f2f4d',
  },
  dayChipOn: { backgroundColor: '#4d8fdb', borderColor: '#4d8fdb' },
  dayChipLabel: { color: '#7aa3d4', fontSize: 13, fontWeight: '600' },
  dayChipLabelOn: { color: '#fff' },

  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 6,
  },
  timeStep: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#11203a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeStepLabel: { color: '#e8f1ff', fontSize: 18, fontWeight: '700' },
  timeValue: {
    color: '#e8f1ff',
    fontSize: 18,
    fontVariant: ['tabular-nums'],
    minWidth: 80,
    textAlign: 'center',
  },
  timeRemove: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#0e1c30',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  addTimeLabel: { color: '#4d8fdb', fontSize: 14, fontWeight: '500' },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 24 },
  primaryButton: {
    backgroundColor: '#4d8fdb',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 6,
    flex: 1,
    alignItems: 'center',
  },
  primaryButtonLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  destructiveButton: {
    backgroundColor: '#0e1c30',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#7a2233',
    alignItems: 'center',
  },
  destructiveButtonLabel: { color: '#f87171', fontSize: 14, fontWeight: '600' },
});
