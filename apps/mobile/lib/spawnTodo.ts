// Manual todo creation. Server creates the wiki_pages row (RLS blocks
// client-side INSERT on wiki_pages) and an optional initial section if
// content was provided.

import { supabase } from './supabase';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export interface SpawnTodoBody {
  title: string;
  content?: string;
}

export interface SpawnTodoResult {
  pageId: string;
}

export async function spawnTodo(body: SpawnTodoBody): Promise<SpawnTodoResult> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  if (!jwt) throw new Error('not signed in');

  const r = await fetch(`${API_URL}/todos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`create failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as SpawnTodoResult;
}
