// Worker-side wrapper around the shared usage-recording helpers. Adds
// Sentry capture on tier-2-crossover events (where our single-rate
// pricing under-counts Google's tiered billing — see pricing.ts).
//
// Both fns swallow errors at the shared layer; this wrapper only adds
// telemetry around the result.

import {
  recordInferenceUsage as sharedRecordInferenceUsage,
  recordWebSearchUsage as sharedRecordWebSearchUsage,
  type RecordInferenceOpts,
  type RecordWebSearchOpts,
} from '@audri/shared/usage';
import * as Sentry from '@sentry/node';
import { logger } from '../logger.js';

export async function recordInferenceUsage(opts: RecordInferenceOpts): Promise<void> {
  const result = await sharedRecordInferenceUsage(opts);

  // Tier-2 surfacing. The shared pricing module currently bills every
  // prompt at the tier-1 rate, even when Google charges more above 200k
  // tokens (gemini-2.5-pro, gemini-3.1-pro-preview). When that happens
  // we're *under-counting* cost; fire a Sentry message so we know to land
  // tier-aware pricing math. v0.2.1: caught + logged, not fixed.
  if (result.tierCrossover) {
    const promptTokens = opts.usage?.promptTokenCount ?? 0;
    Sentry.captureMessage(
      `[usage] tier-2 prompt detected (${opts.model}, ${promptTokens} tokens) — cost under-counted`,
      {
        level: 'warning',
        tags: {
          event_kind: opts.eventKind,
          model: opts.model,
        },
        extra: {
          userId: opts.userId,
          promptTokens,
          recordedCostCents: result.costCents,
        },
      },
    );
    logger.warn(
      { eventKind: opts.eventKind, model: opts.model, promptTokens },
      'usage: tier-2 prompt detected — cost under-counted (Sentry captured)',
    );
  }
}

export async function recordWebSearchUsage(opts: RecordWebSearchOpts): Promise<void> {
  await sharedRecordWebSearchUsage(opts);
}
