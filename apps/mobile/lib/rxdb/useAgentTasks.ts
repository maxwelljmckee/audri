// Reactive query for in-flight agent_tasks. Plugin overlays use this to
// render pending placeholders for queued/running work that hasn't produced
// a result artifact yet. Once status flips to 'succeeded' the row drops out
// of this query (terminal statuses are excluded) and the corresponding
// kind-specific artifact appears in its own collection.

import { useEffect, useState } from 'react';
import { getDatabase } from './database';
import type { AgentTaskDoc } from './schemas';

const ACTIVE_STATUSES = ['pending', 'running'] as const;

export function useActiveAgentTasks(kind: string): AgentTaskDoc[] {
  const [tasks, setTasks] = useState<AgentTaskDoc[]>([]);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.agent_tasks
        .find({
          selector: {
            kind,
            status: { $in: [...ACTIVE_STATUSES] },
          },
          sort: [{ updated_at: 'desc' }],
        })
        // biome-ignore lint/suspicious/noExplicitAny: RxDocument shape is narrow
        .$.subscribe((docs: any[]) => {
          setTasks(docs.map((d) => d.toJSON() as AgentTaskDoc));
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [kind]);

  return tasks;
}
