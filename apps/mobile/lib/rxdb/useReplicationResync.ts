// React hook for pull-to-refresh: triggers a manual pull cycle on every active
// replication, surfaces a refreshing flag for `RefreshControl`.
//
// Why this exists: RxDB's mobile storage is in-memory (see database.ts header
// comment). Realtime subscriptions can hiccup or silently lose updates,
// leaving the local view stale until a re-pull arrives or the user restarts
// the app. Pull-to-refresh is the user's manual escape hatch.

import { useCallback, useState } from 'react';
import { captureClientError } from '../sentry';
import { startReplication } from './replication';

export function useReplicationResync(): {
  refreshing: boolean;
  onRefresh: () => Promise<void>;
} {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const handle = await startReplication();
      await handle.reSync();
      // Brief floor on the spinner so a fast resync doesn't snap shut
      // imperceptibly. 350ms reads as a deliberate refresh, not a flicker.
      await new Promise((r) => setTimeout(r, 350));
    } catch (err) {
      captureClientError('rxdb-resync-trigger', err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { refreshing, onRefresh };
}
