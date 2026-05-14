// Lightweight cache hooks for the Automations tile. No React Query in
// the project — manual state + useEffect + refresh semantics, same
// approach as elsewhere in the app.

import type { AutomationKindMeta } from '@audri/shared/automations';
import { useCallback, useEffect, useState } from 'react';
import { type AutomationRow, fetchActive, fetchSuggested } from './api';

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useSuggestedAutomations(): FetchState<AutomationKindMeta[]> {
  const [data, setData] = useState<AutomationKindMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchSuggested());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}

export function useActiveAutomations(): FetchState<AutomationRow[]> {
  const [data, setData] = useState<AutomationRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchActive());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh };
}
