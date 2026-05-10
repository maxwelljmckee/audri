// React hook: brings up RxDB + Supabase replication when the user signs in,
// tears down on sign-out. Returns a flag indicating whether the database +
// replication are live so screens can render loading state until ready.
//
// Also installs an AppState listener that triggers a manual reSync() on
// background → active transitions. The replication storage is in-memory
// and Supabase realtime can drop silently while backgrounded; without this
// the local view stays stale until the user pulls to refresh or restarts.
// See `notes/data-flow-architecture.md` (sync section) + the v0.2.0 build
// phase doc → outstanding flags for the rationale.

import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { captureClientError } from '../sentry';
import { useSession } from '../useSession';
import { startReplication, stopReplication } from './replication';

export function useRxdbReady(): boolean {
  const session = useSession();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (session.status !== 'signed-in') {
      setReady(false);
      void stopReplication();
      return;
    }

    let cancelled = false;
    void startReplication()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((err) => {
        captureClientError('rxdb-replication-start', err);
      });

    // Foreground re-pull. Only fires on transitions INTO 'active' from
    // background/inactive — repeated 'active' events (some platforms fire
    // them spuriously) are filtered with a previous-state ref.
    let prevState: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const wasBackgrounded = prevState !== 'active';
      prevState = next;
      if (next !== 'active' || !wasBackgrounded) return;
      void startReplication()
        .then((handle) => handle.reSync())
        .catch((err) => {
          captureClientError('rxdb-resync-foreground', err);
        });
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [session.status]);

  return ready;
}
