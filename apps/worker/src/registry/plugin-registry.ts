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
    suggestedAutomations: [
      {
        id: 'morning-brief',
        name: 'Morning brief',
        description:
          'A summary of what is on your plate today — upcoming todos, reminders, ' +
          'and anything stale that needs attention.',
        defaultEnabled: false,
        defaultSchedule: {
          daysOfWeek: [], // every day
          times: ['07:00'],
          jitterMinutes: 30,
        },
      },
    ],
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
    suggestedAutomations: [
      {
        id: 'daily-recap',
        name: 'Daily recap',
        description:
          'An end-of-day reflection on calls, notes, and completed work — ready in the ' +
          'evening so you can review before tomorrow.',
        defaultEnabled: false,
        defaultSchedule: {
          daysOfWeek: [], // every day
          times: ['21:00'],
          jitterMinutes: 30,
        },
      },
      {
        id: 'weekly-recap',
        name: 'Weekly recap',
        description:
          'A Sunday rollup of the past week — themes, accomplishments, decisions. ' +
          'Different shape from daily recaps; pulls back further.',
        defaultEnabled: false,
        defaultSchedule: {
          daysOfWeek: [0], // Sunday
          times: ['09:00'],
          jitterMinutes: 60,
        },
      },
    ],
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
    suggestedAutomations: [
      {
        id: 'weekly-stalled',
        name: 'Weekly stalled-work review',
        description:
          'Every Friday afternoon, a sweep of todos and notes that have gone quiet — so ' +
          'nothing important slips through the cracks.',
        defaultEnabled: false,
        defaultSchedule: {
          daysOfWeek: [5], // Friday
          times: ['15:00'],
          jitterMinutes: 60,
        },
      },
    ],
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
    suggestedAutomations: [
      {
        id: 'weekly-dream-pass',
        name: 'Weekly dream',
        description:
          'Once a week, your agent dreams about everything that has happened — ' +
          'connecting ideas, surfacing patterns, proposing follow-ups.',
        defaultEnabled: true, // ON by default on the default Assistant
        defaultSchedule: {
          daysOfWeek: [6], // Saturday
          times: ['23:00'],
          jitterMinutes: 60,
        },
      },
    ],
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
