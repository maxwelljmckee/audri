// React hook: brings up RxDB + Supabase replication when the user signs in,
// tears down on sign-out. Returns a flag indicating whether the database +
// replication are live so screens can render loading state until ready.

import { useEffect, useState } from 'react';
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

    return () => {
      cancelled = true;
    };
  }, [session.status]);

  return ready;
}
