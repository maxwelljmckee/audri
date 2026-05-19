// Verify script — runs the layered composer against canonical scenarios
// and compares output to the on-disk baseline snapshots captured before
// the refactor. Empty diff = refactor is semantically equivalent.
//
// Usage: from apps/server/, run
//   `tsx src/calls/live-agent-prompt-layers/verify.ts`
//
// Workflow: snapshot.ts captures baseline outputs once (before refactor);
// verify.ts replays the same scenarios post-refactor and ensures parity.
// Update the baseline (by re-running snapshot.ts) only when an intentional
// prompt content change lands.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeLiveAgentPrompt } from './compose.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, '__snapshots__');

const SAMPLE_PRELOAD_BLOCK = `# Preload — what you know about the user

## Profile
- Name: Max
- Lives: Boulder, CO
- Work: building a voice-first knowledge OS called Audri

## Recent activity
- 3 calls in the last 7 days
- 2 new wiki pages this week

## Notes structure (top-level + first-level children)
- profile/
  - profile/work
  - profile/relationships
- projects/
  - projects/audri
- braindump/
- todos/`;

const SAMPLE_PERSONA = `Friendly but measured. Prefers concision. Does not enjoy small talk.`;
const SAMPLE_USER_NOTES = `Always default to short responses. Avoid filler words like "great" or "absolutely".`;

interface Scenario {
  name: string;
  args: Parameters<typeof composeLiveAgentPrompt>[0];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'generic-audio-with-preload',
    args: {
      agentName: 'Audri',
      personaPrompt: SAMPLE_PERSONA,
      userPromptNotes: SAMPLE_USER_NOTES,
      callType: 'generic',
      modality: 'audio',
      preloadBlock: SAMPLE_PRELOAD_BLOCK,
    },
  },
  {
    name: 'generic-audio-no-preload',
    args: {
      agentName: 'Audri',
      personaPrompt: SAMPLE_PERSONA,
      userPromptNotes: SAMPLE_USER_NOTES,
      callType: 'generic',
      modality: 'audio',
    },
  },
  {
    name: 'generic-text-with-preload',
    args: {
      agentName: 'Audri',
      personaPrompt: SAMPLE_PERSONA,
      userPromptNotes: SAMPLE_USER_NOTES,
      callType: 'generic',
      modality: 'text',
      preloadBlock: SAMPLE_PRELOAD_BLOCK,
    },
  },
  {
    name: 'generic-no-persona-no-notes',
    args: {
      agentName: 'Audri',
      personaPrompt: '',
      userPromptNotes: null,
      callType: 'generic',
      modality: 'audio',
      preloadBlock: SAMPLE_PRELOAD_BLOCK,
    },
  },
  {
    name: 'generic-default-modality-undefined',
    args: {
      agentName: 'Audri',
      personaPrompt: SAMPLE_PERSONA,
      userPromptNotes: SAMPLE_USER_NOTES,
      callType: 'generic',
      preloadBlock: SAMPLE_PRELOAD_BLOCK,
    },
  },
  {
    name: 'onboarding-audio',
    args: {
      agentName: 'Audri',
      personaPrompt: SAMPLE_PERSONA,
      userPromptNotes: null,
      callType: 'onboarding',
      modality: 'audio',
    },
  },
  {
    name: 'onboarding-text',
    args: {
      agentName: 'Audri',
      personaPrompt: SAMPLE_PERSONA,
      userPromptNotes: null,
      callType: 'onboarding',
      modality: 'text',
    },
  },
  {
    name: 'onboarding-default-modality-undefined',
    args: {
      agentName: 'Audri',
      personaPrompt: '',
      userPromptNotes: null,
      callType: 'onboarding',
    },
  },
  {
    name: 'generic-audio-with-custom-rules',
    args: {
      agentName: 'Audri',
      personaPrompt: SAMPLE_PERSONA,
      userPromptNotes: SAMPLE_USER_NOTES,
      callType: 'generic',
      modality: 'audio',
      preloadBlock: SAMPLE_PRELOAD_BLOCK,
      customRules: {
        app: [
          'Always cite sources when giving factual information.',
          'Never use emojis unless I explicitly use one first.',
        ],
        agent: [
          'Default to terse responses; expand only when I ask for depth.',
        ],
      },
    },
  },
  {
    name: 'generic-audio-with-app-rules-only',
    args: {
      agentName: 'Audri',
      personaPrompt: SAMPLE_PERSONA,
      userPromptNotes: SAMPLE_USER_NOTES,
      callType: 'generic',
      modality: 'audio',
      preloadBlock: SAMPLE_PRELOAD_BLOCK,
      customRules: {
        app: ['Always cite sources when giving factual information.'],
        agent: [],
      },
    },
  },
];

function firstDifferenceIndex(a: string, b: string): number | null {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  if (a.length !== b.length) return len;
  return null;
}

function snippet(s: string, idx: number, radius = 80): string {
  const start = Math.max(0, idx - radius);
  const end = Math.min(s.length, idx + radius);
  return s.slice(start, end).replaceAll('\n', '\\n');
}

function main(): void {
  let mismatches = 0;
  for (const scenario of SCENARIOS) {
    const composed = composeLiveAgentPrompt(scenario.args);
    const snapshotPath = join(SNAPSHOT_DIR, `${scenario.name}.txt`);
    let baseline: string;
    try {
      baseline = readFileSync(snapshotPath, 'utf-8');
    } catch {
      // eslint-disable-next-line no-console
      console.log(`? ${scenario.name} — NO BASELINE (${snapshotPath})`);
      mismatches++;
      continue;
    }
    if (composed === baseline) {
      // eslint-disable-next-line no-console
      console.log(`✓ ${scenario.name} — IDENTICAL (${composed.length} chars)`);
      continue;
    }
    mismatches++;
    const idx = firstDifferenceIndex(baseline, composed);
    // eslint-disable-next-line no-console
    console.log(
      `✗ ${scenario.name} — DIFFER (baseline=${baseline.length}, composed=${composed.length}, first-diff-at=${idx})`,
    );
    if (idx !== null) {
      // eslint-disable-next-line no-console
      console.log(`  BASELINE: ...${snippet(baseline, idx)}...`);
      // eslint-disable-next-line no-console
      console.log(`  COMPOSED: ...${snippet(composed, idx)}...`);
    }
  }
  if (mismatches > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${mismatches}/${SCENARIOS.length} scenarios mismatched.`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log(`\nAll ${SCENARIOS.length} scenarios match baseline.`);
}

main();
