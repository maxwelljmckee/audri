// Reactive query for agent_open_items — the v0.2 autonomic-loop queue.
//
// Two read patterns:
//   useAgentOpenItems(agentId)        — all items for one persona, ordered
//                                       priority desc then created_at desc.
//                                       Drives the Agents-tile detail view.
//   useAgentOpenItemsPending(agentId) — pending only (`status = 'pending'`),
//                                       same ordering. Drives composer-side
//                                       reads + the surfaceable count badge.
//
// Both subscribe via RxDB's live-query observable so updates land without
// a manual refetch.

import { useEffect, useState } from 'react';
import { getDatabase } from './database';
import type { AgentOpenItemDoc } from './schemas';

const PENDING_STATUS = ['pending'] as const;

function subscribe(
  agentId: string,
  filterPending: boolean,
  setItems: (items: AgentOpenItemDoc[]) => void,
): () => void {
  let sub: { unsubscribe: () => void } | undefined;
  let cancelled = false;

  void getDatabase().then((db) => {
    if (cancelled) return;
    const selector: Record<string, unknown> = { agent_id: agentId };
    if (filterPending) {
      selector.status = { $in: [...PENDING_STATUS] };
    }
    sub = db.collections.agent_open_items
      .find({
        selector,
        sort: [{ priority: 'desc' }, { created_at: 'desc' }],
      })
      // biome-ignore lint/suspicious/noExplicitAny: RxDocument shape is narrow
      .$.subscribe((docs: any[]) => {
        setItems(docs.map((d) => d.toJSON() as AgentOpenItemDoc));
      });
  });

  return () => {
    cancelled = true;
    sub?.unsubscribe();
  };
}

export function useAgentOpenItems(agentId: string | null): AgentOpenItemDoc[] {
  const [items, setItems] = useState<AgentOpenItemDoc[]>([]);

  useEffect(() => {
    if (!agentId) {
      setItems([]);
      return;
    }
    return subscribe(agentId, false, setItems);
  }, [agentId]);

  return items;
}

export function useAgentOpenItemsPending(agentId: string | null): AgentOpenItemDoc[] {
  const [items, setItems] = useState<AgentOpenItemDoc[]>([]);

  useEffect(() => {
    if (!agentId) {
      setItems([]);
      return;
    }
    return subscribe(agentId, true, setItems);
  }, [agentId]);

  return items;
}

// Server-side authoritative status update — push flows through RxDB's normal
// replication. Used by snooze / dismiss interactions in the Agents tile.
// Bumps `updated_at` so the push side picks the change up; otherwise the
// server wouldn't know to apply it.
export async function updateOpenItemStatus(
  itemId: string,
  status: AgentOpenItemDoc['status'],
): Promise<void> {
  const db = await getDatabase();
  const doc = await db.collections.agent_open_items.findOne(itemId).exec();
  if (!doc) return;
  const now = new Date().toISOString();
  await doc.patch({
    status,
    updated_at: now,
    resolved_at: status === 'pending' || status === 'surfaced' ? null : now,
  });
}
