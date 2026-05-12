// Per-model cost table + cost computation for usage_events.cost_cents.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ ⚠️  PRICING VALUES ARE BEST-EFFORT — VERIFY BEFORE USER-FACING ROLLOUT ⚠️ │
// │                                                                          │
// │ Numbers below come from public Gemini pricing as of the `as_of` dates    │
// │ noted on each entry. They were populated from prior knowledge + the      │
// │ Gemini pricing page; one previous value (web-search grounding) was off   │
// │ by 2.5× before correction. Treat every entry as needing a spot-check     │
// │ against ai.google.dev/pricing before the Usage screen ships in front of  │
// │ a real user. Update the `asOf` date when you re-verify.                  │
// │                                                                          │
// │ When pricing changes upstream, edit constants here; we don't backfill    │
// │ historical events at v0.2.1 (per DP-3), so a price change only affects   │
// │ events written after the edit.                                           │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Per-modality rates: Gemini Live splits prompt/response token counts by
// modality (AUDIO / TEXT / IMAGE / VIDEO / DOCUMENT). Audio is priced
// substantially higher than text — typically ~6× — so flat per-model rates
// would be lossy. The pricing entry carries optional per-modality fields;
// when present, the modality-aware compute path uses them. When absent,
// the entry falls back to flat input/output rates.

import type { UsageMetadata } from '@google/genai';

export interface ModelPricing {
  // ISO date string. Re-set when verifying against the current pricing page.
  asOf: string;
  // Flat fallback rates — used for non-Live models and as the default for
  // Live models when modality-specific rates aren't set.
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  // Optional: lower rate for cached input tokens. Most models have this.
  cachedInputUsdPerMillion?: number;
  // Optional per-modality overrides. When present, modality-aware compute
  // uses these in place of the flat rates for the matching modality.
  inputAudioUsdPerMillion?: number;
  outputAudioUsdPerMillion?: number;
  // Token count above which Google bills at a different (higher) rate.
  // When set, prompts exceeding this threshold are *under-priced* by our
  // single-rate compute path — the caller should surface a Sentry message
  // so we know to land tier-aware pricing. See `isTierCrossover()`.
  // v0.2.1: 200_000 for gemini-2.5-pro + gemini-3.1-pro-preview; undefined
  // for everything else.
  tier2ThresholdTokens?: number;
}

// Web-search grounding (googleSearch). Billed per grounded request, NOT
// per token. Each `webSearchQueries[]` entry in the grounding metadata is
// 1 credit. Verified 2026-05-11: $14 / 1k requests = $0.014/request.
export const WEB_SEARCH_USD_PER_REQUEST = 0.014;

// Maps grounding (googleMaps). Same billing model as web search. Verify
// pricing before wiring (see backlog: `maps-grounding` tool). Placeholder
// kept at 0 — when wiring lands, populate from Gemini pricing page.
export const MAPS_SEARCH_USD_PER_REQUEST = 0;

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Non-Live (text-only) ───────────────────────────────────────────────
  // ACTIVE Flash model — used in flash-candidate-retrieval (ingestion
  // prefilter) and agent-scope Flash. Held on 2.5 (not the newer
  // gemini-3-flash-preview below) until we've validated that the preview
  // model honors our strict responseSchema constraints under field load.
  // Cost delta to upgrade is ~$0.0015/call (negligible); the risk is
  // schema regression on a preview model. Flip when confident.
  'gemini-2.5-flash': {
    asOf: '2026-05-11',
    // Text/image/video rate (audio is $1.00/M but we don't send audio to
    // non-Live Flash, so flat-text is fine here).
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5,
    cachedInputUsdPerMillion: 0.03,
  },
  // Upgrade target. Entry kept warm so the swap is a one-line change in
  // each FLASH_MODEL constant. Validate against the strict-JSON-output
  // paths (Flash candidate retrieval responseSchema, agent-scope Flash
  // responseSchema) before flipping. Storage price for context caching
  // ($1.00/1M tokens/hour) not tracked here — separate event_kind if we
  // adopt caching aggressively.
  'gemini-3-flash-preview': {
    asOf: '2026-05-11',
    inputUsdPerMillion: 0.5,
    outputUsdPerMillion: 3.0,
    // Context caching: $0.05/M text/image/video, $0.10/M audio. Text only
    // for this path.
    cachedInputUsdPerMillion: 0.05,
  },
  // Not currently used in any inference path — kept for completeness so
  // future code that opts into 2.5-pro has a pricing entry waiting.
  'gemini-2.5-pro': {
    asOf: '2026-05-11',
    // ≤200k tokens. >200k tier is $2.50 input / $15.00 output —
    // surfaced via Sentry capture in record-inference; tier-aware
    // pricing math is V1+ work.
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 10.0,
    cachedInputUsdPerMillion: 0.125,
    tier2ThresholdTokens: 200_000,
  },
  // Used in: Pro fan-out (post-call ingestion), research handler.
  'gemini-3.1-pro-preview': {
    asOf: '2026-05-11',
    // ≤200k tokens. >200k tier is $4.00 input / $18.00 output —
    // surfaced via Sentry capture; tier-aware pricing math is V1+ work.
    inputUsdPerMillion: 2.0,
    outputUsdPerMillion: 12.0,
    cachedInputUsdPerMillion: 0.2,
    tier2ThresholdTokens: 200_000,
  },
  // Customtools variant — same pricing as gemini-3.1-pro-preview per the
  // Gemini docs ("gemini-3.1-pro-preview and gemini-3.1-pro-preview-customtools").
  'gemini-3.1-pro-preview-customtools': {
    asOf: '2026-05-11',
    inputUsdPerMillion: 2.0,
    outputUsdPerMillion: 12.0,
    cachedInputUsdPerMillion: 0.2,
    tier2ThresholdTokens: 200_000,
  },

  // ── Live (audio + text) ───────────────────────────────────────────────
  // Used in: live agent calls. Audio is priced separately from text. The
  // model splits token counts by modality in usageMetadata's
  // promptTokensDetails / responseTokensDetails arrays — we multiply each
  // modality's count by its rate.
  //
  // NOTE: Gemini also publishes a per-minute audio-billing alternative
  // ($0.005/min input, $0.018/min output). We bill via token count here
  // since that's what the SDK surfaces; the per-minute rate is mostly for
  // pricing-page comparison.
  'gemini-3.1-flash-live-preview': {
    asOf: '2026-05-11',
    // Text-modality rates (used as fallback for non-AUDIO modalities).
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 4.5,
    // Audio-modality rates.
    inputAudioUsdPerMillion: 3.0,
    outputAudioUsdPerMillion: 12.0,
  },

  // ── Grounding pseudo-model ────────────────────────────────────────────
  // Web-search grounding usage_events carry this synthetic model name so
  // the row joins cleanly to a pricing entry, even though the actual cost
  // is computed via WEB_SEARCH_USD_PER_REQUEST × credits, not tokens.
  // computeCostCents shouldn't be called for this model — use
  // computeWebSearchCostCents instead. Kept here so reporting queries can
  // resolve a display label.
  'gemini-grounding': {
    asOf: '2026-05-11',
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
  },
};

// NUMERIC(12, 4) — column carries cents with 4 decimal places of precision.
// We return strings rather than numbers because JS floats are unsafe at
// that precision and Drizzle accepts decimal-as-string for NUMERIC.
type CostCentsString = string;

// Per-modality token aggregation used by both the audio-aware Live path
// and the flat fallback. Walks UsageMetadata once, summing AUDIO tokens
// separately so they can be priced at a different rate.
interface TokenBreakdown {
  audioTokens: number;
  nonAudioTokens: number;
}

function aggregateModality(
  details: UsageMetadata['promptTokensDetails'] | undefined,
  flatTotal: number,
): TokenBreakdown {
  if (!details || details.length === 0) {
    // No modality breakdown available — treat everything as non-audio.
    return { audioTokens: 0, nonAudioTokens: flatTotal };
  }
  let audio = 0;
  let nonAudio = 0;
  for (const d of details) {
    const count = d.tokenCount ?? 0;
    if (d.modality === 'AUDIO') audio += count;
    else nonAudio += count;
  }
  // If the modality-split totals don't match the flat total, trust the
  // flat (it's authoritative per the API contract). Stuff the delta into
  // non-audio — safest default since audio is the more expensive modality.
  const splitTotal = audio + nonAudio;
  if (splitTotal !== flatTotal && flatTotal > 0) {
    nonAudio += flatTotal - splitTotal;
  }
  return { audioTokens: audio, nonAudioTokens: nonAudio };
}

// Compute cost from a Gemini UsageMetadata blob. Handles modality-aware
// pricing when the model + the usage data both support it; otherwise
// falls back to flat per-million rates. Tool-use prompt tokens fold into
// input. Cached tokens get the cached rate where defined.
//
// Returns a NUMERIC(12, 4)-compatible string for direct insert. "0" for
// unknown models (with a console warn so we can spot stale pricing).
export function computeCostCents(model: string, usage: UsageMetadata): CostCentsString {
  // SDK uses `models/<id>` for Live; strip the prefix so the table keys
  // can stay short. Non-Live calls return `<id>` directly and pass
  // through unchanged.
  const key = model.startsWith('models/') ? model.slice('models/'.length) : model;
  const pricing = MODEL_PRICING[key];
  if (!pricing) {
    console.warn(`[pricing] unknown model "${model}" — cost recorded as 0`);
    return '0';
  }

  const prompt = aggregateModality(usage.promptTokensDetails, usage.promptTokenCount ?? 0);
  // Field-name fallback: `responseTokenCount` is the newer name (per the
  // SDK type def) but production responses still arrive with the older
  // `candidatesTokenCount` field on at least some API versions. Read both
  // — whichever is populated wins. Confirmed in field test 2026-05-12
  // where stored usage_events rows showed input tokens captured + output
  // always at 0; once the fallback was added, real output counts came in.
  const responseTokens =
    usage.responseTokenCount ??
    (usage as { candidatesTokenCount?: number }).candidatesTokenCount ??
    0;
  const response = aggregateModality(usage.responseTokensDetails, responseTokens);
  const toolUsePrompt = aggregateModality(
    usage.toolUsePromptTokensDetails,
    usage.toolUsePromptTokenCount ?? 0,
  );
  // Cached tokens get the discounted rate if defined; otherwise the normal
  // input rate. The API exposes cached tokens already-included in
  // promptTokenCount, so we don't double-charge them — we just credit the
  // discount by subtracting (input - cached) rate from total.
  const cachedTokens = usage.cachedContentTokenCount ?? 0;

  // Convert per-million rates to per-token at compute time, in USD cents
  // (multiply by 100 once at the end).
  const audioInputRate = pricing.inputAudioUsdPerMillion ?? pricing.inputUsdPerMillion;
  const audioOutputRate = pricing.outputAudioUsdPerMillion ?? pricing.outputUsdPerMillion;

  let usdTotal = 0;

  // Prompt + tool-use prompt — both count as input.
  usdTotal += (prompt.audioTokens / 1_000_000) * audioInputRate;
  usdTotal += (prompt.nonAudioTokens / 1_000_000) * pricing.inputUsdPerMillion;
  usdTotal += (toolUsePrompt.audioTokens / 1_000_000) * audioInputRate;
  usdTotal += (toolUsePrompt.nonAudioTokens / 1_000_000) * pricing.inputUsdPerMillion;

  // Response.
  usdTotal += (response.audioTokens / 1_000_000) * audioOutputRate;
  usdTotal += (response.nonAudioTokens / 1_000_000) * pricing.outputUsdPerMillion;

  // Cached-input discount — refund the difference between the normal rate
  // and the cached rate, in proportion to cached tokens.
  if (cachedTokens > 0 && pricing.cachedInputUsdPerMillion !== undefined) {
    const discount =
      (cachedTokens / 1_000_000) * (pricing.inputUsdPerMillion - pricing.cachedInputUsdPerMillion);
    usdTotal -= discount;
  }

  // Floor at 0 (defensive — discount math should never overshoot but cheap
  // to guard against a pricing-config typo).
  if (usdTotal < 0) usdTotal = 0;

  return (usdTotal * 100).toFixed(4);
}

// Detect whether a prompt crossed into the model's higher pricing tier.
// Returns true when the model has a `tier2ThresholdTokens` set AND the
// inference's prompt token count exceeded it. Used by the caller to
// surface a Sentry message so we know to land tier-aware pricing math
// (currently the cost is *under-counted* for tier-2 prompts because we
// apply the tier-1 rate everywhere). v0.2.1: caught + logged, not fixed.
//
// Lookup strips a `models/` prefix to match the SDK's full model ID
// against the table's keys.
export function isTier2Crossover(model: string, usage: UsageMetadata): boolean {
  const key = model.startsWith('models/') ? model.slice('models/'.length) : model;
  const pricing = MODEL_PRICING[key];
  if (!pricing?.tier2ThresholdTokens) return false;
  const prompt = usage.promptTokenCount ?? 0;
  return prompt > pricing.tier2ThresholdTokens;
}

// Web-search grounding cost — billed per grounded request, not per token.
// Each `webSearchQueries[]` entry in grounding metadata is 1 credit.
export function computeWebSearchCostCents(credits: number): CostCentsString {
  if (credits <= 0) return '0';
  const usdTotal = credits * WEB_SEARCH_USD_PER_REQUEST;
  return (usdTotal * 100).toFixed(4);
}

// Maps grounding cost — same billing shape as web search.
export function computeMapsSearchCostCents(credits: number): CostCentsString {
  if (credits <= 0) return '0';
  const usdTotal = credits * MAPS_SEARCH_USD_PER_REQUEST;
  return (usdTotal * 100).toFixed(4);
}

// Aggregate token totals for the integer columns on usage_events
// (`input_tokens`, `output_tokens`, `cached_tokens`). Pulled from the
// same UsageMetadata so writers don't have to re-parse. Tool-use prompt
// tokens fold into input for the at-a-glance count; the cost calculation
// above tracked them separately for correctness.
export function tokenTotalsFromUsage(usage: UsageMetadata): {
  input: number;
  output: number;
  cached: number;
} {
  // See `computeCostCents` for the responseTokenCount / candidatesTokenCount
  // fallback rationale. Same field-name drift between SDK type def and
  // runtime payloads.
  const responseTokens =
    usage.responseTokenCount ??
    (usage as { candidatesTokenCount?: number }).candidatesTokenCount ??
    0;
  return {
    input: (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0),
    output: responseTokens,
    cached: usage.cachedContentTokenCount ?? 0,
  };
}
