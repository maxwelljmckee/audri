// Wiki pending indicator. Surfaced at the top of the Wiki plugin between calls
// and ingestion completion, telling the user "we know you're expecting new
// content here, we're working on it." Built on the existing agent_tasks RxDB
// sync — when an ingestion task is pending or running, this banner shows.
//
// v0.2 substrate. Lifecycle:
//   - User ends a call → server enqueues `ingestion-${user_id}` job →
//     agent_tasks row inserted with kind='ingestion', status='pending'
//   - Worker picks up → status='running'
//   - Fan-out commits → status='succeeded' → banner clears
// Failures (status='failed') currently behave like succeeded for this banner —
// the surface is "is something in flight?" not "did it succeed?". A separate
// failed-ingestion error surface exists in v0.2.1 (todos retry button).
//
// Note: 'ingestion' isn't yet a registered agent_task_kind — current
// ingestion runs as a Graphile job directly without an agent_tasks row.
// This banner becomes load-bearing once v0.2's autonomic-loop work creates
// agent_tasks rows for ingestion. Until then it's a no-op (good — no false
// positives). See `worker/src/ingestion/` for the current pipeline.

import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useActiveAgentTasks } from '../../lib/rxdb/useAgentTasks';

export function WikiPendingBanner() {
  const tasks = useActiveAgentTasks('ingestion');
  if (tasks.length === 0) return null;

  const message =
    tasks.length === 1
      ? 'Ingesting your last call — new notes arrive in a moment.'
      : `Ingesting ${tasks.length} calls — new notes arrive in a moment.`;

  return (
    <View style={styles.banner}>
      <ActivityIndicator color="#4d8fdb" size="small" />
      <Text style={styles.text} numberOfLines={2}>
        {message}
      </Text>
      <Ionicons name="time-outline" size={14} color="#7aa3d4" />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#0e1c30',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2f4d',
  },
  text: {
    flex: 1,
    color: '#7aa3d4',
    fontSize: 12,
    lineHeight: 16,
  },
});
