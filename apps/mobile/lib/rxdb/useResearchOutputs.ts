// Reactive RxDB query hooks for research_outputs.

import { useEffect, useState } from 'react';
import { getDatabase } from './database';
import type { ResearchOutputDoc } from './schemas';

export function useResearchOutputs(): ResearchOutputDoc[] {
  const [outputs, setOutputs] = useState<ResearchOutputDoc[]>([]);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;

    void getDatabase().then((db) => {
      if (cancelled) return;
      sub = db.collections.research_outputs
        .find({
          selector: { tombstoned_at: null },
          sort: [{ generated_at: 'desc' }],
        })
        // biome-ignore lint/suspicious/noExplicitAny: RxDocument type is narrow; toJSON returns the typed shape
        .$.subscribe((docs: any[]) => {
          setOutputs(docs.map((d) => d.toJSON() as ResearchOutputDoc));
        });
    });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, []);

  return outputs;
}
