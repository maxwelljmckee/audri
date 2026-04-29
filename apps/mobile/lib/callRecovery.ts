// Local snapshot of an in-flight call so a force-quit / network drop /
// background-suspend doesn't lose the transcript. The snapshot is overwritten
// on each transcript change during the call and cleared on a clean /end.
//
// On app launch, useCallRecovery() reads the snapshot. If it's older than
// STALE_THRESHOLD_MS, the call is assumed dead and POSTed to /end with the
// cached transcript + end_reason='network_drop' so the row is closed and
// ingestion can run.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TranscriptTurn } from './gemini/transcript';
import { captureClientError } from './sentry';
import { supabase } from './supabase';

const STORAGE_KEY = 'audri:active-call-snapshot:v1';
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export interface CallSnapshot {
  sessionId: string;
  startedAt: string; // ISO
  lastTouched: string; // ISO
  transcript: TranscriptTurn[];
  callType: 'generic' | 'onboarding';
}

export async function saveCallSnapshot(snapshot: CallSnapshot): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    captureClientError('call-recovery-save', err);
  }
}

export async function clearCallSnapshot(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    // Swallow + console only — clear-after-success failure is harmless;
    // next launch's sweep will tidy up any orphan.
    console.warn('[call-recovery] clearCallSnapshot failed', err);
  }
}

export async function readCallSnapshot(): Promise<CallSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CallSnapshot;
  } catch (err) {
    captureClientError('call-recovery-read', err);
    return null;
  }
}

// Fire /calls/:sessionId/end with the cached snapshot. Used by both the
// background-suspend handler (immediate, while session is fresh) and the
// app-launch orphan sweep (after the fact, with end_reason='network_drop').
export async function recoverCall(
  snapshot: CallSnapshot,
  endReason: 'network_drop' | 'app_backgrounded' = 'network_drop',
): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  if (!jwt) {
    console.warn('[call-recovery] no auth — leaving snapshot for next launch');
    return;
  }
  const r = await fetch(`${API_URL}/calls/${snapshot.sessionId}/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      transcript: snapshot.transcript,
      started_at: snapshot.startedAt,
      ended_at: new Date().toISOString(),
      end_reason: endReason,
    }),
  });
  if (!r.ok) {
    throw new Error(`recover failed: ${r.status} ${await r.text()}`);
  }
}

export function isStale(snapshot: CallSnapshot, now = Date.now()): boolean {
  const last = new Date(snapshot.lastTouched).getTime();
  if (!Number.isFinite(last)) return true;
  return now - last > STALE_THRESHOLD_MS;
}
