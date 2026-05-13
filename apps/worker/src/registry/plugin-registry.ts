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

// v0.3.0 B1 extension. Each plugin can declare zero or more
// suggested-default automations. The Automations tile reads this
// catalog to seed each user's "Available" view; toggling one ON
// creates a recurring_agent_tasks row with the declared defaults.
//
// `id` is the stable identifier used for dedup — a user can only have
// one active recurring row per (plugin kind, suggested id). Renaming
// the id is a breaking change (existing rows would orphan).
//
// Schedule defaults follow the recurring_agent_tasks schema shape:
// daysOfWeek 0-6 (postgres extract(dow), empty = every day), times
// as "HH:MM" strings. Timezone falls through to user_settings at
// instantiation time.
export interface SuggestedAutomation {
  id: string;
  name: string;
  description: string;
  // Default-on means the row gets created (in paused=false state)
  // automatically when the user first opens the Automations tile,
  // without an explicit toggle. Reserve for low-cost / unambiguous
  // automations (e.g. Dreaming on the default Assistant). User can
  // still pause/delete after.
  defaultEnabled: boolean;
  defaultSchedule: {
    daysOfWeek: number[];
    times: string[];
    jitterMinutes?: number; // default 30 if omitted
  };
  defaultPayload?: Record<string, unknown>;
}

export interface PluginEntry {
  kind: string;
  capabilityDescription: string;
  modelTier: 'flash' | 'pro';
  tokenBudget: number;
  timeoutMs: number;
  maxAttempts: number;
  defaultPriority: number;
  reingestsIntoWiki: boolean;
  // Optional list of suggested-default automations. Empty for plugins
  // that aren't scheduled (e.g. research is user-spawned, not recurring).
  suggestedAutomations?: SuggestedAutomation[];
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
