import { useEffect, useState } from 'react';
import { supabase } from './supabase';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export interface MePayload {
  user: { id: string; email?: string };
  agents: Array<{
    id: string;
    slug: string;
    name: string;
    voice: string;
    rootPageId: string | null;
    isDefault: boolean;
    createdAt: string;
    tombstonedAt: string | null;
  }>;
  userSettings: {
    userId: string;
    enabledPlugins: string[];
    onboardingComplete: boolean;
    timezone: string | null;
    // NUMERIC(12, 2) — null = no cap, otherwise string (Drizzle returns
    // NUMERIC as string to preserve precision).
    monthlySpendLimitCents: string | null;
    monthlySpendWarningThreshold: number;
    createdAt: string;
    updatedAt: string;
  } | null;
}

export type MeState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: MePayload };

export function useMe(accessToken: string | null): MeState {
  const [state, setState] = useState<MeState>({ status: 'loading' });

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    fetch(`${API_URL}/me`, { headers: { Authorization: `Bearer ${accessToken}` } })
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setState({ status: 'error', error: `HTTP ${r.status}` });
          return;
        }
        const data = (await r.json()) as MePayload;
        setState({ status: 'ready', data });
        // Fire-and-forget timezone sync. v0.2.1 Usage feature buckets
        // daily spend in the user's local time; server needs the IANA
        // name. Posts only when the device-detected tz differs from
        // what's already stored — keeps the call cheap on subsequent
        // launches.
        syncTimezone(accessToken, data.userSettings?.timezone ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  return state;
}

function syncTimezone(accessToken: string, serverTz: string | null): void {
  let deviceTz: string;
  try {
    deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return;
  }
  if (!deviceTz || deviceTz === serverTz) return;
  void fetch(`${API_URL}/me/timezone`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ timezone: deviceTz }),
  }).catch(() => {
    // Best-effort. Next launch retries; aggregation falls back to UTC.
  });
}
