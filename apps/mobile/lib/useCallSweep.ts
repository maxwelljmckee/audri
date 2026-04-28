// On app launch (and on auth-ready), check for an orphaned call snapshot —
// e.g. force-quit during a call, or a backgrounded recovery that didn't
// reach the server. If the snapshot is stale (lastTouched > 5min ago) we
// POST /end with the cached transcript + end_reason='network_drop' so the
// row is closed and ingestion can run.
//
// Only fires once per session-signed-in transition; doesn't poll.

import { useEffect, useRef } from 'react';
import {
  clearCallSnapshot,
  isStale,
  readCallSnapshot,
  recoverCall,
} from './callRecovery';
import { useSession } from './useSession';

export function useCallRecoverySweep() {
  const session = useSession();
  const sweptRef = useRef(false);

  useEffect(() => {
    if (session.status !== 'signed-in') {
      sweptRef.current = false;
      return;
    }
    if (sweptRef.current) return;
    sweptRef.current = true;

    (async () => {
      const snapshot = await readCallSnapshot();
      if (!snapshot) return;
      if (!isStale(snapshot)) {
        // Snapshot is fresh → there's a live call elsewhere (or a tight
        // app-restart window). Leave it alone; either useCall will resume
        // updating it or the next sweep will catch it once stale.
        return;
      }
      try {
        await recoverCall(snapshot, 'network_drop');
        await clearCallSnapshot();
        console.log(
          '[call-sweep] recovered orphaned call',
          snapshot.sessionId,
          'with',
          snapshot.transcript.length,
          'turns',
        );
      } catch (err) {
        console.warn('[call-sweep] recovery failed; will retry next launch', err);
      }
    })();
  }, [session.status]);
}
