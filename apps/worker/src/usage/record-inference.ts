// Helper to write a usage_events row from a Gemini inference. Called
// after every generateContent / Live-session-end in the worker.
//
// Best-effort: failures log + swallow, never throw. Usage tracking is
// observability — a write failure should not fail the surrounding work.

import { db, usageEvents } from '@audri/shared/db';
import {
  computeCostCents,
  computeWebSearchCostCents,
  isTier2Crossover,
  tokenTotalsFromUsage,
} from '@audri/shared/usage';
import type { UsageMetadata } from '@google/genai';
import * as Sentry from '@sentry/node';
import { logger } from '../logger.js';

type EventKind =
  | 'call_live'
  | 'ingestion_prefilter'
  | 'ingestion'
  | 'agent_scope_ingestion'
  | 'plugin_research'
  | 'tool_search_wiki'
  | 'tool_fetch_page'
  | 'web_search';

export interface RecordInferenceOpts {
  userId: string;
  // Persona on whose behalf the inference ran. Optional — backend tasks
  // not tied to a specific persona (e.g. hygiene sweep) can omit. When
  // present, drives the future per-agent breakdown UI.
  agentId?: string;
  // Source transcript when this inference rode on a call. Lets the Usage
  // dashboard collapse all call-adjacent inference (Flash retrieval + Pro
  // fan-out + agent-scope + custom tool calls) into one "Live Agent"
  // category at aggregation time.
  callTranscriptId?: string | null;
  // For plugin-spawned inference (research handler).
  agentTaskId?: string | null;
  eventKind: EventKind;
  model: string;
  usage: UsageMetadata | undefined | null;
}

export async function recordInferenceUsage(opts: RecordInferenceOpts): Promise<void> {
  if (!opts.usage) {
    // No usageMetadata on the response — rare but possible. Skip the
    // write rather than insert a zero-cost row; that would distort the
    // event-count denominator in any "average cost per call" analytics.
    return;
  }
  const tokens = tokenTotalsFromUsage(opts.usage);
  const costCents = computeCostCents(opts.model, opts.usage);

  // Tier-2 surfacing. The shared pricing module currently bills every
  // prompt at the tier-1 rate, even when Google charges more above 200k
  // tokens (gemini-2.5-pro, gemini-3.1-pro-preview). When that happens
  // we're *under-counting* cost; fire a Sentry message so we know to land
  // tier-aware pricing math. v0.2.1: caught + logged, not fixed.
  if (isTier2Crossover(opts.model, opts.usage)) {
    const promptTokens = opts.usage.promptTokenCount ?? 0;
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
          recordedCostCents: costCents,
        },
      },
    );
    logger.warn(
      { eventKind: opts.eventKind, model: opts.model, promptTokens },
      'usage: tier-2 prompt detected — cost under-counted (Sentry captured)',
    );
  }
  try {
    await db.insert(usageEvents).values({
      userId: opts.userId,
      agentId: opts.agentId ?? null,
      agentTasksId: opts.agentTaskId ?? null,
      eventKind: opts.eventKind,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cachedTokens: tokens.cached,
      model: opts.model,
      costCents,
      callTranscriptId: opts.callTranscriptId ?? null,
    });
  } catch (err) {
    // Don't surface — observability writes should not fail the parent
    // job. Log loud enough that it'll show in Sentry / Render logs.
    logger.error(
      { err, eventKind: opts.eventKind, model: opts.model, userId: opts.userId },
      'usage_events insert failed (continuing)',
    );
  }
}

export interface RecordWebSearchOpts {
  userId: string;
  agentId?: string;
  callTranscriptId?: string | null;
  // Number of googleSearch grounding requests fired during the call.
  // Each `webSearchQueries[]` entry in grounding metadata is 1 credit.
  credits: number;
}

// Record a `web_search` usage_event for the googleSearch credits a call
// consumed. Aggregated per-call rather than per-grounding-fire to keep
// row count low while preserving the cost figure. Best-effort like
// recordInferenceUsage.
export async function recordWebSearchUsage(opts: RecordWebSearchOpts): Promise<void> {
  if (opts.credits <= 0) return;
  const costCents = computeWebSearchCostCents(opts.credits);
  try {
    await db.insert(usageEvents).values({
      userId: opts.userId,
      agentId: opts.agentId ?? null,
      eventKind: 'web_search',
      // No token counts — grounding is per-request billing. Stash the
      // credit count in `inputTokens` for at-a-glance reporting; cost is
      // the authoritative number for $-aggregation.
      inputTokens: opts.credits,
      outputTokens: 0,
      cachedTokens: 0,
      model: 'gemini-grounding',
      costCents,
      callTranscriptId: opts.callTranscriptId ?? null,
    });
  } catch (err) {
    logger.error(
      { err, credits: opts.credits, userId: opts.userId },
      'web_search usage_events insert failed (continuing)',
    );
  }
}
