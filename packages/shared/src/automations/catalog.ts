// Suggested-automations catalog. Single source of truth for the
// per-plugin / per-kind defaults the Automations tile surfaces under
// the "Suggested" tab.
//
// Consumers:
//   - apps/worker/src/registry/plugin-registry.ts — re-binds these
//     entries onto each plugin's full registry record (worker-only
//     fields like handler refs + prompts live there alongside).
//   - apps/server/src/automations/ — exposes the catalog to mobile
//     via GET /automations/suggested.
//
// Schedule shape mirrors recurring_agent_tasks:
//   - daysOfWeek: 0-6, postgres extract(dow) (0=Sun). Empty = every day.
//   - times: "HH:MM" strings, interpreted in user-local timezone at
//     instantiation time (timezone resolved from user_settings).
//   - jitterMinutes: per-(user_id, recurring_task_id)-stable jitter
//     window. Subtract from nominal → user gets the output BY the
//     nominal time. Default 30 if omitted.
//
// `id` is the stable dedup identifier — a user can only have ONE active
// row per (kind, suggestedId). Renaming an id is a breaking change.

export interface SuggestedAutomation {
  id: string;
  name: string;
  description: string;
  // Auto-create the row (in paused=false state) the first time the
  // user opens the Automations tile, without an explicit toggle.
  // Reserve for low-cost / unambiguous defaults (e.g. Dreaming on
  // the default Assistant). User can still pause/delete after.
  defaultEnabled: boolean;
  defaultSchedule: {
    daysOfWeek: number[];
    times: string[];
    jitterMinutes?: number;
  };
  defaultPayload?: Record<string, unknown>;
}

// How the Suggested tab groups kinds. Drives section headers in the UI.
// 'core' — app-level, not owned by a specific plugin.
// 'agent' — per-agent (Dreaming).
// '<plugin>' — owned by a specific plugin (todos, notes, storage,
//   research). Future kinds extend this union.
export type AutomationCategory =
  | 'core'
  | 'agent'
  | 'todos'
  | 'notes'
  | 'storage'
  | 'research';

export interface AutomationKindMeta {
  // agent_task_kind enum value. Matches recurring_agent_tasks.kind.
  kind: string;
  category: AutomationCategory;
  // Display label for the kind, used as a section header in the
  // Suggested tab and as the parent folder title in wiki output.
  // Examples: "Recaps", "Briefs", "Stalled work", "Dreaming".
  label: string;
  // 1-2 sentence prose describing what this kind does. Surfaced on
  // the suggested-card before the user expands details.
  capabilityBlurb: string;
  suggested: SuggestedAutomation[];
}

export const AUTOMATION_CATALOG: AutomationKindMeta[] = [
  {
    kind: 'brief_me',
    category: 'core',
    label: 'Briefs',
    capabilityBlurb:
      'A forward-looking summary of what is on your plate — upcoming todos, ' +
      'reminders, and anything stale worth a glance.',
    suggested: [
      {
        id: 'morning-brief',
        name: 'Morning brief',
        description:
          'A summary of what is on your plate today — upcoming todos, reminders, ' +
          'and anything stale that needs attention.',
        defaultEnabled: false,
        defaultSchedule: {
          daysOfWeek: [],
          times: ['07:00'],
          jitterMinutes: 30,
        },
      },
    ],
  },
  {
    kind: 'recap',
    category: 'core',
    label: 'Recaps',
    capabilityBlurb:
      'A backward-looking reflection on what got done or discussed. Synthesized ' +
      'as a single coherent page, not a list. Daily or weekly cadence.',
    suggested: [
      {
        id: 'daily-recap',
        name: 'Daily recap',
        description:
          'An end-of-day reflection on calls, notes, and completed work — ready in ' +
          'the evening so you can review before tomorrow.',
        defaultEnabled: false,
        defaultSchedule: {
          daysOfWeek: [],
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
          daysOfWeek: [0],
          times: ['09:00'],
          jitterMinutes: 60,
        },
      },
    ],
  },
  {
    kind: 'stalled_work',
    category: 'core',
    label: 'Stalled work',
    capabilityBlurb:
      'A focused weekly review of stalled todos, dropped follow-ups, and notes ' +
      'that have gone quiet — surfacing balls that may have been dropped.',
    suggested: [
      {
        id: 'weekly-stalled',
        name: 'Weekly stalled-work review',
        description:
          'Every Friday afternoon, a sweep of todos and notes that have gone quiet — ' +
          'so nothing important slips through the cracks.',
        defaultEnabled: false,
        defaultSchedule: {
          daysOfWeek: [5],
          times: ['15:00'],
          jitterMinutes: 60,
        },
      },
    ],
  },
  {
    kind: 'dreaming',
    category: 'agent',
    label: 'Dreaming',
    capabilityBlurb:
      'Your agent dreams about recent activity, drawing connections between notes, ' +
      'transcripts, and research — then surfaces new insights for you to review.',
    suggested: [
      {
        id: 'weekly-dream-pass',
        name: 'Weekly dream',
        description:
          'Once a week, your agent dreams about everything that has happened — ' +
          'connecting ideas, surfacing patterns, proposing follow-ups.',
        // ON by default on the default Assistant. Gated by handler
        // readiness at the seeding call site — see #25 in v0.3.0 plan.
        defaultEnabled: true,
        defaultSchedule: {
          daysOfWeek: [6],
          times: ['23:00'],
          jitterMinutes: 60,
        },
      },
    ],
  },
];

// Lookup helpers — small, exact-match. Callers should treat missing
// kinds / ids as "user error" (404), not as silent fallthrough.

export function findKindMeta(kind: string): AutomationKindMeta | undefined {
  return AUTOMATION_CATALOG.find((k) => k.kind === kind);
}

export function findSuggestedAutomation(
  kind: string,
  suggestedId: string,
): SuggestedAutomation | undefined {
  return findKindMeta(kind)?.suggested.find((s) => s.id === suggestedId);
}
