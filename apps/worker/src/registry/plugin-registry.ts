// Plugin registry — server-side authoritative source for what each agent_task
// kind does. One entry per kind. Per todos.md §11 + specs/research-task-prompt.md.
//
// MVP plugin set: just `research`. V1+ adds podcast / email_draft /
// calendar_event / brief / etc.
//
// At MVP, this registry is consulted by the agent_task_dispatch handler
// (slice 7) to look up which handler to call for a given task kind.
//
// Note: ingestion is NOT a plugin — it's a built-in internal pipeline that
// runs against transcripts. Plugins are user-facing capabilities.

export interface PluginEntry {
  kind: string;
  capabilityDescription: string;
  modelTier: 'flash' | 'pro';
  tokenBudget: number;
  timeoutMs: number;
  maxAttempts: number;
  defaultPriority: number;
  reingestsIntoWiki: boolean;
  // Handler implementation lands in slice 7. Typed as `unknown` until then so
  // the registry shape is stable but no slice-7 code is required to compile.
  handler?: (ctx: unknown) => Promise<unknown>;
}

export const pluginRegistry: Record<string, PluginEntry> = {
  research: {
    kind: 'research',
    capabilityDescription:
      'Perform web research on a topic and produce a structured report with citations. ' +
      'Best for questions where the answer needs grounding in current web sources ' +
      '(news, products, places, recent events, technical topics).',
    modelTier: 'pro',
    tokenBudget: 30_000,
    timeoutMs: 120_000,
    maxAttempts: 2,
    defaultPriority: 5,
    reingestsIntoWiki: false,
    // handler: researchHandler  // ← lands in slice 7
  },
};

// Client-safe subset (no handler refs, no full prompt strings). Sent to the
// mobile app for capability advertisement. Slice 7+ surface.
export const pluginRegistryLite = Object.fromEntries(
  Object.entries(pluginRegistry).map(([kind, entry]) => [
    kind,
    {
      kind: entry.kind,
      capabilityDescription: entry.capabilityDescription,
      defaultPriority: entry.defaultPriority,
    },
  ]),
);
