// Shared helper to write a usage_events row from a Gemini inference.
// Called by both server (Live session writer at /end) and worker (every
// generateContent path).
//
// Best-effort: failures log + swallow, never throw. Usage tracking is
// observability — a write failure should not fail the surrounding work.
//
// Sentry capture for tier-2-crossover events is the CALLER's job — this
// module stays free of @sentry/node so it can be imported by the
// mobile bundle without dragging in node-only deps. Callers fire Sentry
// using the returned `tierCrossover` flag.

import type { UsageMetadata } from '@google/genai';
import { db, usageEvents } from '../db/index.js';
import { computeCostCents, isTier2Crossover, tokenTotalsFromUsage } from './pricing.js';

export type UsageEventKind =
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
  eventKind: UsageEventKind;
  model: string;
  usage: UsageMetadata | undefined | null;
  // Non-token billing dims + auxiliary observability data. Lands in the
  // `usage_extras` JSONB column. Reserve well-known keys:
  //   - `callDurationSeconds` (number) — total call length when the row
  //     was written for an event_kind = 'call_live' inference. Enables
  //     per-minute analytics + future routing-input heuristics ("30-sec
  //     calls are almost always trivial; 15-min calls are almost always
  //     complex"). Set by the /calls/:id/end handler.
  //   - `webSearchCredits` (number) — googleSearch grounding credits;
  //     written by `recordWebSearchUsage` for event_kind = 'web_search'.
  //   - additional keys reserved as new billing dims emerge (e.g.
  //     `mapsSearchCredits` for the future maps-grounding tool).
  extras?: Record<string, unknown>;
}

export interface RecordInferenceResult {
  // True when the row was inserted; false on missing usage data or
  // swallowed insert failure.
  inserted: boolean;
  // True when the prompt crossed into the model's higher pricing tier.
  // Caller should fire a Sentry capture if true — our cost figure is
  // under-counted (tier-aware math is V1+). Always false when not
  // inserted.
  tierCrossover: boolean;
  // For at-call-site logging / debugging. '0' when no insert.
  costCents: string;
}

// Async-fire-and-don't-throw insert. Returns metadata about what was
// recorded so the caller can fire Sentry on tier-2 or log to its own
// telemetry channel without re-querying.
export async function recordInferenceUsage(
  opts: RecordInferenceOpts,
): Promise<RecordInferenceResult> {
  if (!opts.usage) {
    return { inserted: false, tierCrossover: false, costCents: '0' };
  }
  const tokens = tokenTotalsFromUsage(opts.usage);
  const costCents = computeCostCents(opts.model, opts.usage);
  const tierCrossover = isTier2Crossover(opts.model, opts.usage);

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
      // Lossless per-modality + per-category breakdown. Typed rollups
      // above flatten audio/text/thinking into a single output column;
      // this preserves the original truth so we can re-price historical
      // rows or audit modality mix later. See migration 0024.
      tokenBreakdown: opts.usage as Record<string, unknown>,
      usageExtras: opts.extras ?? null,
      callTranscriptId: opts.callTranscriptId ?? null,
    });
    return { inserted: true, tierCrossover, costCents };
  } catch (err) {
    // Console-error reaches Render logs at minimum. Worker + server both
    // wrap in their own telemetry on top of this.
    console.error('[usage] usage_events insert failed', {
      err: err instanceof Error ? err.message : String(err),
      eventKind: opts.eventKind,
      model: opts.model,
      userId: opts.userId,
    });
    return { inserted: false, tierCrossover: false, costCents: '0' };
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
// consumed. Best-effort like recordInferenceUsage.
export async function recordWebSearchUsage(opts: RecordWebSearchOpts): Promise<boolean> {
  if (opts.credits <= 0) return false;
  const { computeWebSearchCostCents } = await import('./pricing.js');
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
      // Authoritative billing dimension for grounding rows. Future
      // MAPS-grounding lands here with `mapsSearchCredits`.
      usageExtras: { webSearchCredits: opts.credits },
      callTranscriptId: opts.callTranscriptId ?? null,
    });
    return true;
  } catch (err) {
    console.error('[usage] web_search usage_events insert failed', {
      err: err instanceof Error ? err.message : String(err),
      credits: opts.credits,
      userId: opts.userId,
    });
    return false;
  }
}
