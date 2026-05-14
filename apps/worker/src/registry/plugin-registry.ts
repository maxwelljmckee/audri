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
// suggested-default automations. The Automations tile reads the
// catalog to seed each user's "Suggested" view; toggling one ON
// creates a recurring_agent_tasks row with the declared defaults.
//
// The catalog itself lives in @audri/shared/automations so both the
// server (which exposes /automations/suggested to mobile) and the
// worker (which uses defaults during scheduled fires) read the same
// source. The worker registry below maps each kind to its catalog
// entry's `suggested` array — no duplication.

import { AUTOMATION_CATALOG, type SuggestedAutomation } from '@audri/shared/automations';

const suggestedByKind: Record<string, SuggestedAutomation[]> = Object.fromEntries(
  AUTOMATION_CATALOG.map((meta) => [meta.kind, meta.suggested]),
);

export type { SuggestedAutomation };

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
    // Research is user-spawned, not scheduled — no suggested automations.
    // handler: researchHandler  // ← lands in slice 7
  },

  // ── App-level automations (no specific plugin owner) ───────────────
  // These appear in the Automations tile under "Core" rather than a
  // per-plugin section. Output lands at /automations/<kind>/ per the
  // locked wiki layout. Handlers stub here; mechanics land in #24.

  brief_me: {
    kind: 'brief_me',
    capabilityDescription:
      'A recurring forward-looking summary of upcoming reminders, due todos, scheduled ' +
      'research follow-ups, and other agenda items — plus inline flags for outstanding ' +
      'stale items. Lands as a wiki page under /automations/briefs/.',
    modelTier: 'pro',
    tokenBudget: 15_000,
    timeoutMs: 120_000,
    maxAttempts: 2,
    defaultPriority: 5,
    reingestsIntoWiki: false,
    suggestedAutomations: suggestedByKind.brief_me,
  },

  recap: {
    kind: 'recap',
    capabilityDescription:
      'A recurring backward-looking reflection on what got done or discussed — daily or ' +
      'weekly. Synthesized as a single coherent page, not a list. Lands under ' +
      '/automations/recaps/.',
    modelTier: 'pro',
    tokenBudget: 15_000,
    timeoutMs: 120_000,
    maxAttempts: 2,
    defaultPriority: 5,
    reingestsIntoWiki: false,
    suggestedAutomations: suggestedByKind.recap,
  },

  stalled_work: {
    kind: 'stalled_work',
    capabilityDescription:
      'A focused weekly review of stalled todos, dropped follow-ups, and notes that have ' +
      'gone quiet — surfacing balls that may have been dropped. Distinct from the inline ' +
      'flagging in Brief Me; this is the dedicated deep sweep. Lands at /automations/stalled/.',
    modelTier: 'pro',
    tokenBudget: 12_000,
    timeoutMs: 120_000,
    maxAttempts: 2,
    defaultPriority: 5,
    reingestsIntoWiki: false,
    suggestedAutomations: suggestedByKind.stalled_work,
  },

  // ── Agent-level automation (per-agent) ─────────────────────────────

  dreaming: {
    kind: 'dreaming',
    capabilityDescription:
      'Agent "dreams" about recent activity, drawing connections between ideas, notes, ' +
      'transcripts, and research — then synthesizes new insights. Lands as dream pages ' +
      'under the agent in /automations/dreams/. Configurable as cron (daily/weekly) or ' +
      'as an "every call" trigger that runs after each call ends.',
    modelTier: 'pro',
    tokenBudget: 30_000,
    timeoutMs: 300_000, // dreams can be long-running (Light/REM/Deep phases)
    maxAttempts: 2,
    defaultPriority: 4,
    reingestsIntoWiki: false,
    suggestedAutomations: suggestedByKind.dreaming,
  },

  // ── Todos-level capability (per-reminder rows; not a single toggle) ─

  todo_reminder: {
    kind: 'todo_reminder',
    capabilityDescription:
      'A reminder is a recurring rule that produces todos on schedule. Each fire creates ' +
      'ONE todo with the appropriate due date. Active reminders always have exactly one ' +
      'outstanding future todo at any time (rolling creation). Reminders are user-created ' +
      'via the Todos plugin or the live agent — they do not surface as a single suggested ' +
      'default to toggle on.',
    modelTier: 'flash', // cheap; just creates a todo row
    tokenBudget: 2_000,
    timeoutMs: 30_000,
    maxAttempts: 2,
    defaultPriority: 6,
    reingestsIntoWiki: false,
    // No suggestedAutomations — reminders are created per-instance by the
    // user (via Todos tab or live-agent NL "remind me to..."). The Todos
    // plugin tile surfaces a "Reminders" tab for create/edit; the
    // Automations plugin surfaces the same rows under a "Reminders"
    // manage section for pause/edit.
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
