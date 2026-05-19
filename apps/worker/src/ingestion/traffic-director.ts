// Ingestion traffic director — thin deterministic routing layer at the TOP
// of the ingestion pipeline, BEFORE Flash candidate retrieval and Pro fan-out.
//
// Per `specs/customization-framework.md` § Quick Wins, the director routes
// each transcript into one of N downstream branches:
//
//   1. empty          — pure heuristic bypass (no inference). Skip every-
//                       thing downstream. Mark transcript as succeeded with
//                       zero claims; no usage events.
//   2. task_only      — Flash classifier flags task-mutation-only intent.
//                       Skip Pro fan-out; route to Todo specialist directly.
//                       DEFERRED — wires in once Todo specialist lands.
//   3. settings_only  — Flash classifier flags settings-mutation-only intent.
//                       Skip Pro fan-out; route to settings specialist.
//                       DEFERRED — wires in once settings specialist lands.
//   4. standard       — current pipeline (Flash candidate retrieval → Pro
//                       fan-out → commit). Default route.
//
// **Asymmetric failure cost — bias toward standard.** Routing to task_only
// or settings_only when the transcript ALSO had notes content = silent
// information loss (bad). Routing to standard when it was actually a fast-
// path candidate = wasted inference cost (cheap). Heuristic + classifier
// must overshoot the safe path under uncertainty.
//
// **Telemetry is mandatory.** Every routing decision emits a structured log
// line. Branch distribution data informs future decisions (the deferred
// Pro-fork question in backlog).
//
// v0.4.0 quick-win scope: the EMPTY branch only. task_only and settings_only
// are stubbed to return 'standard' until their specialists land. The hooks
// + telemetry are in place so adding the new branches is mechanical.

import type { IngestionTranscriptTurn } from './flash-candidate-retrieval.js';

export type TrafficRoute = 'empty' | 'task_only' | 'settings_only' | 'standard';

export interface TrafficClassification {
  route: TrafficRoute;
  reason: string;
  // Diagnostic fields surfaced in telemetry.
  userTurnCount: number;
  userWordCount: number;
  agentTurnCount: number;
  durationSeconds: number | null;
  classifierLatencyMs: number;
}

// Word-count threshold below which a transcript is treated as empty even
// when user turns exist. Empirical floor from dogfood 2026-05-19: the
// shortest plausible substantive directive ("remind me to call mom", "add
// a todo to buy milk", "take a note about X") is ≥5 words. Anything below
// is mic-check / accidental-open / "yeah hi audri" — bypass safely.
// Configurable via env for tuning if telemetry shows false positives.
const EMPTY_USER_WORD_THRESHOLD = Number(
  process.env.INGESTION_EMPTY_USER_WORD_THRESHOLD ?? 5,
);

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/**
 * Classify a transcript into one of the routing branches. Pure function
 * (no I/O), deterministic, sub-millisecond. Pre-Pro and pre-Flash —
 * empty-bypass branch runs zero inference.
 *
 * v0.4.0 quick-win scope: empty + standard branches only. task_only +
 * settings_only stubs return standard.
 */
export function classifyTranscript(
  transcript: IngestionTranscriptTurn[],
  durationSeconds: number | null,
): TrafficClassification {
  const startedAt = Date.now();

  let userTurnCount = 0;
  let agentTurnCount = 0;
  let userWordCount = 0;

  for (const turn of transcript) {
    if (turn.role === 'user') {
      userTurnCount++;
      userWordCount += countWords(turn.text);
    } else if (turn.role === 'agent') {
      agentTurnCount++;
    }
  }

  const base = {
    userTurnCount,
    userWordCount,
    agentTurnCount,
    durationSeconds,
    classifierLatencyMs: Date.now() - startedAt,
  };

  // Branch 1: empty bypass.
  // Zero user turns OR sub-threshold user word count. Bias toward standard
  // means the bar is LOW — any meaningful sentence (3+ words) escapes
  // the bypass.
  if (userTurnCount === 0) {
    return {
      ...base,
      route: 'empty',
      reason: 'zero_user_turns',
    };
  }
  if (userWordCount < EMPTY_USER_WORD_THRESHOLD) {
    return {
      ...base,
      route: 'empty',
      reason: `user_word_count_below_threshold (${userWordCount} < ${EMPTY_USER_WORD_THRESHOLD})`,
    };
  }

  // Branch 2: task_only — DEFERRED until Todo specialist lands.
  // Branch 3: settings_only — DEFERRED until settings specialist lands.
  // Both stubbed to fall through to standard.

  return {
    ...base,
    route: 'standard',
    reason: 'default',
  };
}
