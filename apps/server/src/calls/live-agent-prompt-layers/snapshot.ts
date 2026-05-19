// Snapshot script — captures composeSystemPrompt output for canonical
// input combinations and writes each to `__snapshots__/<scenario>.txt`.
//
// Usage: from apps/server/, run `tsx src/calls/live-agent-prompt-layers/snapshot.ts`.
//
// Purpose: behavioral test for the Live Agent prompt-decomposition refactor.
// Capture baseline → refactor incrementally → re-run script → diff against
// baseline. If the diff is empty or trivially whitespace-only, the refactor
// is semantically equivalent to the original (because the model only sees
// the composed string).
//
// Scenarios cover the matrix of (callType × modality × preloadBlock present)
// plus persona/notes variants. Edit / add scenarios when new conditional
// branches land in the composer.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSystemPrompt } from '../live-agent-prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_DIR = join(__dirname, '__snapshots__');

// Sample preload block — small but representative of the shape the real
// renderer emits (profile + agent notes + recent activity + page tree).
// Kept compact so snapshot diffs are readable; the LAYERED version doesn't
// need to reproduce arbitrary preload content, just inline whatever the
// renderer hands it.
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
  args: Parameters<typeof composeSystemPrompt>[0];
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
];

function main(): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const scenario of SCENARIOS) {
    const composed = composeSystemPrompt(scenario.args);
    const outPath = join(SNAPSHOT_DIR, `${scenario.name}.txt`);
    writeFileSync(outPath, composed);
    // eslint-disable-next-line no-console
    console.log(`[snapshot] wrote ${scenario.name}.txt (${composed.length} chars)`);
  }
}

main();
