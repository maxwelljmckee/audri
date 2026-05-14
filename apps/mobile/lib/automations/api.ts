// Typed REST surface for the Automations tile. Five endpoints, all JWT-gated.
//
// Why not RxDB: recurring_agent_tasks isn't replicated client-side. The
// row volume is tiny (handful per user) and mutations involve server-
// computed fields (next_run_at via stable per-row jitter); REST keeps
// the source of truth clean.

import type {
  AutomationKindMeta,
  ScheduleSpec,
} from '@audri/shared/automations';
import { supabase } from '../supabase';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export interface AutomationRow {
  id: string;
  kind: string;
  suggested_id: string | null;
  agent_id: string | null;
  days_of_week: number[];
  times: string[];
  timezone: string;
  jitter_minutes: number;
  payload: unknown;
  trigger_mode: string;
  paused: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_agent_task_id: string | null;
  created_at: string;
  updated_at: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  if (!jwt) throw new Error('not signed in');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` };
}

async function handle<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status}: ${body}`);
  }
  return (await r.json()) as T;
}

export async function fetchSuggested(): Promise<AutomationKindMeta[]> {
  const r = await fetch(`${API_URL}/automations/suggested`, { headers: await authHeaders() });
  const { catalog } = await handle<{ catalog: AutomationKindMeta[] }>(r);
  return catalog;
}

export async function fetchActive(): Promise<AutomationRow[]> {
  const r = await fetch(`${API_URL}/automations`, { headers: await authHeaders() });
  const { rows } = await handle<{ rows: AutomationRow[] }>(r);
  return rows;
}

export async function instantiateAutomation(input: {
  kind: string;
  suggestedId: string;
  agentId?: string | null;
}): Promise<AutomationRow> {
  const r = await fetch(`${API_URL}/automations`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      kind: input.kind,
      suggested_id: input.suggestedId,
      agent_id: input.agentId ?? null,
    }),
  });
  const { row } = await handle<{ row: AutomationRow }>(r);
  return row;
}

export interface PatchAutomationInput
  extends Partial<Pick<ScheduleSpec, 'daysOfWeek' | 'times' | 'timezone' | 'jitterMinutes'>> {
  paused?: boolean;
  payload?: Record<string, unknown>;
}

export async function patchAutomation(
  id: string,
  patch: PatchAutomationInput,
): Promise<AutomationRow> {
  // Snake-case the keys to match the server DTO.
  const body: Record<string, unknown> = {};
  if (patch.daysOfWeek !== undefined) body.days_of_week = patch.daysOfWeek;
  if (patch.times !== undefined) body.times = patch.times;
  if (patch.timezone !== undefined) body.timezone = patch.timezone;
  if (patch.jitterMinutes !== undefined) body.jitter_minutes = patch.jitterMinutes;
  if (patch.paused !== undefined) body.paused = patch.paused;
  if (patch.payload !== undefined) body.payload = patch.payload;

  const r = await fetch(`${API_URL}/automations/${id}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  const { row } = await handle<{ row: AutomationRow }>(r);
  return row;
}

export async function deleteAutomation(id: string): Promise<void> {
  const r = await fetch(`${API_URL}/automations/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  await handle<{ ok: true }>(r);
}
