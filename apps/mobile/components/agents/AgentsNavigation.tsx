// Agents plugin's stack navigation. Two screens:
//   List   — agent cards (avatar, name, persona). N=1 in v0.2 (research
//             persona Audri); designed to scale to multiple personas in V1+.
//   Detail — per-agent details. Configurations section (stub for V1+) +
//             open questions section (the live queue read from RxDB).
//
// Per DP-4 resolution (2026-05-09): passive transparency surface — user
// sees what the persona is curious about + can snooze/dismiss items, but
// can NOT manually seed questions. Manual seeding is V1+ if observed need.

import { Ionicons } from '@expo/vector-icons';
import {
  type NativeStackScreenProps,
  createNativeStackNavigator,
} from '@react-navigation/native-stack';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AgentOpenItemDoc } from '../../lib/rxdb/schemas';
import { updateOpenItemStatus, useAgentOpenItems } from '../../lib/rxdb/useAgentOpenItems';
import { useReplicationResync } from '../../lib/rxdb/useReplicationResync';
import { useRxdbReady } from '../../lib/rxdb/useRxdbReady';
import { useMe } from '../../lib/useMe';
import { useSession } from '../../lib/useSession';
import { PluginBackRow, pluginStackScreenOptions } from '../PluginStack';
import { ResyncControl } from '../ResyncControl';

export type AgentsStackParamList = {
  List: undefined;
  Detail: { agentId: string };
};

const Stack = createNativeStackNavigator<AgentsStackParamList>();

export function AgentsStack() {
  return (
    <Stack.Navigator screenOptions={pluginStackScreenOptions} initialRouteName="List">
      <Stack.Screen name="List" component={ListScreen} />
      <Stack.Screen name="Detail" component={DetailScreen} />
    </Stack.Navigator>
  );
}

// ── List screen ──────────────────────────────────────────────────────────────

function ListScreen({ navigation }: NativeStackScreenProps<AgentsStackParamList, 'List'>) {
  const session = useSession();
  const accessToken = session.status === 'signed-in' ? session.session.access_token : null;
  const me = useMe(accessToken);
  const { refreshing, onRefresh } = useReplicationResync();

  if (me.status === 'loading') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#4d8fdb" />
      </View>
    );
  }
  if (me.status === 'error') {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>Couldn't load agents: {me.error}</Text>
      </View>
    );
  }

  const agents = me.data.agents.filter((a) => a.tombstonedAt === null);

  return (
    <FlatList
      data={agents}
      keyExtractor={(a) => a.id}
      contentContainerStyle={styles.list}
      refreshControl={<ResyncControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No agents yet.</Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          style={styles.agentCard}
          onPress={() => navigation.push('Detail', { agentId: item.id })}
        >
          <View style={styles.avatar}>
            <Ionicons name="sparkles-outline" size={24} color="#7aa3d4" />
          </View>
          <View style={styles.agentMain}>
            <Text style={styles.agentName}>{item.name}</Text>
            <Text style={styles.agentPersona}>Assistant</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#3f5a83" />
        </Pressable>
      )}
    />
  );
}

// ── Detail screen ────────────────────────────────────────────────────────────

function DetailScreen({
  navigation,
  route,
}: NativeStackScreenProps<AgentsStackParamList, 'Detail'>) {
  const ready = useRxdbReady();
  const session = useSession();
  const accessToken = session.status === 'signed-in' ? session.session.access_token : null;
  const me = useMe(accessToken);
  const { refreshing, onRefresh } = useReplicationResync();

  const agent =
    me.status === 'ready' ? me.data.agents.find((a) => a.id === route.params.agentId) : null;

  const items = useAgentOpenItems(route.params.agentId);
  const visibleItems = items.filter((i) => i.status === 'pending' || i.status === 'surfaced');

  return (
    <View style={styles.flex}>
      <PluginBackRow label="Agents" onPress={() => navigation.goBack()} />
      <FlatList
        data={visibleItems}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.detailList}
        refreshControl={<ResyncControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          <View>
            <View style={styles.detailHeader}>
              <View style={styles.avatarLarge}>
                <Ionicons name="sparkles-outline" size={32} color="#7aa3d4" />
              </View>
              <Text style={styles.detailName}>{agent?.name ?? 'Agent'}</Text>
              <Text style={styles.detailPersona}>Assistant</Text>
            </View>

            {/* Configurations — stubbed placeholder for V1+. */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Configurations</Text>
              <View style={styles.stub}>
                <Text style={styles.stubText}>Configuration options coming soon.</Text>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionLabel}>
                Open questions {visibleItems.length > 0 ? `(${visibleItems.length})` : ''}
              </Text>
              {!ready && <Text style={styles.subtle}>Syncing…</Text>}
              {ready && visibleItems.length === 0 && (
                <Text style={styles.subtle}>
                  Nothing on {agent?.name ?? 'this agent'}'s mind yet. Items appear here as the
                  agent reflects on your conversations.
                </Text>
              )}
            </View>
          </View>
        }
        renderItem={({ item }) => <OpenItemRow item={item} />}
      />
    </View>
  );
}

function OpenItemRow({ item }: { item: AgentOpenItemDoc }) {
  return (
    <View style={styles.itemRow}>
      <View style={styles.itemMain}>
        <View style={styles.itemMeta}>
          <Ionicons
            name={item.kind === 'question' ? 'help-circle-outline' : 'bulb-outline'}
            size={14}
            color="#7aa3d4"
          />
          <Text style={styles.itemKind}>{item.kind === 'question' ? 'Question' : 'Insight'}</Text>
          {item.topic ? <Text style={styles.itemTopic}>· {item.topic}</Text> : null}
        </View>
        <Text style={styles.itemBody} numberOfLines={4}>
          {item.body_text}
        </Text>
      </View>
      <View style={styles.itemActions}>
        <Pressable
          onPress={() => void updateOpenItemStatus(item.id, 'dismissed')}
          hitSlop={6}
          style={styles.itemAction}
        >
          <Ionicons name="close-outline" size={18} color="#7aa3d4" />
        </Pressable>
      </View>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { color: '#7aa3d4', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  list: { paddingVertical: 8 },
  agentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#11203a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  agentMain: { flex: 1, gap: 2 },
  agentName: { color: '#e8f1ff', fontSize: 16, fontWeight: '600' },
  agentPersona: { color: '#7aa3d4', fontSize: 12 },

  detailList: { paddingBottom: 24 },
  detailHeader: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 8,
  },
  avatarLarge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#11203a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailName: { color: '#e8f1ff', fontSize: 22, fontWeight: '600' },
  detailPersona: { color: '#7aa3d4', fontSize: 13 },

  section: { paddingHorizontal: 16, paddingTop: 16, gap: 8 },
  sectionLabel: {
    color: '#7aa3d4',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  subtle: { color: '#7aa3d4', fontSize: 13, lineHeight: 18 },
  stub: {
    backgroundColor: '#0e1c30',
    borderRadius: 8,
    padding: 14,
  },
  stubText: { color: '#7aa3d4', fontSize: 13, fontStyle: 'italic' },

  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  itemMain: { flex: 1, gap: 4 },
  itemMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  itemKind: { color: '#7aa3d4', fontSize: 11, fontWeight: '600' },
  itemTopic: { color: '#7aa3d4', fontSize: 11 },
  itemBody: { color: '#e8f1ff', fontSize: 14, lineHeight: 20 },
  itemActions: { flexDirection: 'row', gap: 4 },
  itemAction: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: '#11203a',
  },
});
