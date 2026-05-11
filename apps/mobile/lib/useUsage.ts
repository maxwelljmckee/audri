// Hook for the Account → Usage screen. Fetches GET /me/usage and
// returns the aggregation shape ready for chart rendering. Re-fetches
// when accessToken or month changes. Manual refresh is exposed too so
// the screen can wire pull-to-refresh.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export interface UsageData {
  // 'YYYY-MM' user-local
  month: string;
  // Total spend in cents (NUMERIC, may have 4 decimal places of precision).
  totalCents: number;
  daily: Array<{ day: string; cents: number }>;
  byCategory: {
    liveAgent: number;
    webSearch: number;
    research: number;
    other: Record<string, number>;
  };
  limit: {
    cents: number | null;
    thresholdReached: boolean;
    warningThreshold: number;
  };
}

export type UsageState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: UsageData };

interface UseUsageReturn {
  state: UsageState;
  refresh: () => Promise<void>;
}

export function useUsage(month?: string): UseUsageReturn {
  const [state, setState] = useState<UsageState>({ status: 'loading' });

  const fetchUsage = useCallback(async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        setState({ status: 'error', error: 'not signed in' });
        return;
      }
      const url = month ? `${API_URL}/me/usage?month=${month}` : `${API_URL}/me/usage`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setState({ status: 'error', error: `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as UsageData;
      setState({ status: 'ready', data });
    } catch (err) {
      setState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [month]);

  useEffect(() => {
    void fetchUsage();
  }, [fetchUsage]);

  return { state, refresh: fetchUsage };
}

// Update the user's monthly spend limit. `limitCents = null` clears it.
// `threshold` (0..1] sets the warning-banner threshold (defaults to 0.8
// server-side if unset). Returns true on success.
export async function updateSpendingLimit(opts: {
  limitCents: number | null;
  threshold?: number;
}): Promise<boolean> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) return false;
    const res = await fetch(`${API_URL}/me/spending-limit`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        limit_cents: opts.limitCents,
        threshold: opts.threshold,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
