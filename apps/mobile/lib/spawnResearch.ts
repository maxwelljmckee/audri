// POST a manual research request to the server. Returns the new agent_task id.
// Server creates the agent_tasks row + originating todo wiki page + enqueues
// the dispatch job in a single transaction.

import { supabase } from './supabase';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export interface SpawnResearchResult {
  agentTaskId: string;
  todoPageId: string;
}

export async function spawnResearch(query: string): Promise<SpawnResearchResult> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  if (!jwt) throw new Error('not signed in');

  const r = await fetch(`${API_URL}/tasks/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`spawn failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as SpawnResearchResult;
}
