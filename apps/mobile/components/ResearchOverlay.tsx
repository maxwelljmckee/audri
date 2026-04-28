import { Ionicons } from '@expo/vector-icons';
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
import { useResearchOutputs } from '../lib/rxdb/useResearchOutputs';
import { useRxdbReady } from '../lib/rxdb/useRxdbReady';
import { spawnResearch } from '../lib/spawnResearch';
import { PluginOverlay } from './PluginOverlay';
import { ResearchOutputDetail } from './ResearchOutputDetail';

type ResearchView = 'list' | 'spawn' | 'detail';

export function ResearchOverlay() {
  const ready = useRxdbReady();
  const outputs = useResearchOutputs();
  const [view, setView] = useState<ResearchView>('list');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeOutput = activeId ? outputs.find((o) => o.id === activeId) ?? null : null;

  async function submit() {
    const trimmed = query.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await spawnResearch(trimmed);
      setQuery('');
      setView('list');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PluginOverlay kind="research" title="Research">
      {!ready ? (
        <View style={styles.loading}>
          <Text style={styles.loadingText}>Syncing…</Text>
        </View>
      ) : view === 'detail' && activeOutput ? (
        <ResearchOutputDetail
          output={activeOutput}
          onBack={() => {
            setActiveId(null);
            setView('list');
          }}
        />
      ) : view === 'spawn' ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.flex}
        >
          <Pressable style={styles.backRow} onPress={() => setView('list')}>
            <Ionicons name="chevron-back" size={20} color="#7aa3d4" />
            <Text style={styles.backLabel}>Research</Text>
          </Pressable>
          <View style={styles.spawnBody}>
            <Text style={styles.spawnTitle}>What should I research?</Text>
            <Text style={styles.spawnHint}>
              Be specific. Good prompts include the question + any constraints (location, timeframe, depth).
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
      ) : (
        <View style={styles.flex}>
          <Pressable style={styles.spawnRow} onPress={() => setView('spawn')}>
            <Ionicons name="add-circle-outline" size={22} color="#4d8fdb" />
            <Text style={styles.spawnRowLabel}>New research</Text>
          </Pressable>
          <FlatList
            data={outputs}
            keyExtractor={(o) => o.id}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  No research yet. Tap "New research" or ask Audri to look something up mid-call.
                </Text>
              </View>
            }
            renderItem={({ item }) => (
              <Pressable
                style={styles.row}
                onPress={() => {
                  setActiveId(item.id);
                  setView('detail');
                }}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowTitle} numberOfLines={2}>
                    {item.query}
                  </Text>
                  <Text style={styles.rowMeta}>
                    {new Date(item.generated_at).toLocaleDateString()} · {item.findings.length}{' '}
                    finding{item.findings.length === 1 ? '' : 's'} · {item.citations.length} source
                    {item.citations.length === 1 ? '' : 's'}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
              </Pressable>
            )}
          />
        </View>
      )}
    </PluginOverlay>
  );
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
  rowMain: { flex: 1, gap: 4 },
  rowTitle: { color: '#e8f1ff', fontSize: 15, fontWeight: '500' },
  rowMeta: { color: '#7aa3d4', fontSize: 12 },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  backLabel: { color: '#7aa3d4', fontSize: 15 },
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
