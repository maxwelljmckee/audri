// Resolve Rumi's (the ingestion agent's) knob values for a given user.
//
// Reads user_agent_settings.overrides for the user's ingestion-type agent;
// merges over the global KnobSpec defaults (per spec § 1 LD1). Returns
// the resolved KnobValueSpec entries plus a routing decision for
// model_intelligence='adaptive' (the complexity classifier runs inline
// here when applicable; sentinel signal flows out via `effectiveModel`).
//
// Architecture note: knob resolution is read-only; no DB writes. Settings
// specialist owns writes. This module just reads + interprets.

import { agents, and, db, eq, userAgentSettings } from '@audri/shared/db';
import type { KnobSpec, KnobValueSpec } from '@audri/shared/knobs';
import {
  resolveKnobValue,
  RUMI_INTELLIGENCE,
  RUMI_WRITING_STYLE,
} from '@audri/shared/knobs';
import type { IngestionTranscriptTurn } from './flash-candidate-retrieval.js';
import { logger } from '../logger.js';

// Threshold heuristics for the Adaptive complexity classifier.
// Initial values chosen by intuition; tune against telemetry once we
// have routing-decision data.
const COMPLEXITY_USER_WORD_THRESHOLD = Number(
  process.env.RUMI_COMPLEXITY_USER_WORD_THRESHOLD ?? 200,
);
const COMPLEXITY_CANDIDATE_THRESHOLD = Number(
  process.env.RUMI_COMPLEXITY_CANDIDATE_THRESHOLD ?? 5,
);

export interface ResolvedRumiKnobs {
  // Effective model name to use for Pro fan-out. Always resolves to a
  // concrete Gemini model ID — 'adaptive' is collapsed to flash/pro
  // by the complexity classifier (see resolveRumiKnobs).
  effectiveModel: string;
  // The raw intelligence choice (low/adaptive/high). Useful for
  // telemetry — distinguishes "user chose High" from "adaptive picked High".
  intelligenceChoice: string;
  // For api_config knobs that compose into the Gemini call config.
  // Merged from each api_config knob's resolved value. thinking_config
  // is stripped when effectiveModel is Flash (Flash has no reasoning_effort).
  apiConfig: Record<string, unknown>;
  // The writing_style prompt injection text. Appended to Pro fan-out's
  // system prompt at the Behavioral layer position. Empty string when
  // somehow misconfigured (shouldn't happen post-validateKnobSpec).
  writingStylePromptInjection: string;
  // Diagnostic: which writing style was active.
  writingStyleChoice: string;
}

// Compute a complexity signal for the Adaptive classifier. Inputs the
// classifier could plausibly use:
//   - user-turn word count (longer = more complex)
//   - Flash candidate set size (more touched/new pages = more complex)
//   - presence of convention-setting / rule-update phrasing (handled by
//     settings specialist, so the rule's just routing; if present,
//     escalate to Pro for safer convention capture)
//   - presence of cross-page contradictions (hard to detect cheaply; punt)
//
// v0.4.0: simple sum of word-count + candidate-count thresholds. Threshold
// tuning is env-overridable. Telemetry on routing decisions feeds future
// classifier iteration.
function classifyComplexity(
  transcript: IngestionTranscriptTurn[],
  candidateCount: number,
): 'simple' | 'complex' {
  let userWords = 0;
  for (const t of transcript) {
    if (t.role !== 'user') continue;
    userWords += t.text
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
  }
  if (userWords >= COMPLEXITY_USER_WORD_THRESHOLD) return 'complex';
  if (candidateCount >= COMPLEXITY_CANDIDATE_THRESHOLD) return 'complex';
  return 'simple';
}

export interface ResolveRumiKnobsInput {
  userId: string;
  // The transcript + candidate count feed the Adaptive complexity
  // classifier when model_intelligence='adaptive'. Pass both even when
  // the user chose 'low' or 'high' — the inputs are cheap and we log
  // the complexity signal regardless for future calibration.
  transcript: IngestionTranscriptTurn[];
  candidateCount: number;
}

export async function resolveRumiKnobs(
  opts: ResolveRumiKnobsInput,
): Promise<ResolvedRumiKnobs> {
  // Find this user's ingestion agent (Rumi). Seeded per-user at signup;
  // unique by (user_id, slug='rumi'). Fall back to type='ingestion'
  // (handles future seed renames).
  const [rumi] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, opts.userId), eq(agents.type, 'ingestion')))
    .limit(1);

  let overrides: Record<string, unknown> | null = null;
  if (rumi) {
    const [settings] = await db
      .select({ overrides: userAgentSettings.overrides })
      .from(userAgentSettings)
      .where(
        and(
          eq(userAgentSettings.userId, opts.userId),
          eq(userAgentSettings.agentId, rumi.id),
        ),
      )
      .limit(1);
    overrides = (settings?.overrides as Record<string, unknown> | null) ?? null;
  } else {
    logger.warn(
      { userId: opts.userId },
      'rumi-knobs: no ingestion agent found for user — using defaults only',
    );
  }

  // Resolve each user-facing knob (override → spec default).
  const writingStyleVal = resolveKnobValue(RUMI_WRITING_STYLE, overrides);
  const intelligenceVal = resolveKnobValue(RUMI_INTELLIGENCE, overrides);

  // Adaptive resolution: when the intelligence knob's api_config.model is
  // the 'adaptive' sentinel, run the complexity classifier to pick Flash
  // or Pro. Otherwise use the declared model directly. Telemetry: log the
  // classifier signal + decision for every call (including non-adaptive —
  // useful for tuning when users flip back to adaptive).
  const complexity = classifyComplexity(opts.transcript, opts.candidateCount);
  const declaredModel = (intelligenceVal.api_config?.model as string | undefined) ?? '';
  const effectiveModel: string = (() => {
    if (declaredModel === 'adaptive') {
      return complexity === 'complex' ? 'gemini-3.1-pro-preview' : 'gemini-2.5-flash';
    }
    return declaredModel || 'gemini-3.1-pro-preview';
  })();
  logger.info(
    {
      userId: opts.userId,
      intelligenceChoice: intelligenceVal.value,
      complexity,
      effectiveModel,
      writingStyleChoice: writingStyleVal.value,
    },
    'rumi-knobs: resolved',
  );

  // Pull thinking_config from the intelligence knob's api_config (the
  // combined knob carries both `model` and `thinking_config`). Drop the
  // `model` key from the merged config — that's surfaced separately via
  // `effectiveModel` so the caller can pass it as the top-level model
  // arg to generateContent. Also strip `thinking_config` when running on
  // Flash (no reasoning_effort param). Destructure rather than `delete`
  // (Biome perf rule).
  const apiConfig: Record<string, unknown> = (() => {
    const cfg = intelligenceVal.api_config ?? {};
    if (effectiveModel !== 'gemini-2.5-flash') {
      const { model: _m, ...rest } = cfg as Record<string, unknown>;
      return rest;
    }
    const { model: _m, thinking_config: _tc, ...rest } = cfg as Record<string, unknown>;
    return rest;
  })();

  return {
    effectiveModel,
    intelligenceChoice: intelligenceVal.value as string,
    apiConfig,
    writingStylePromptInjection: writingStyleVal.prompt_injection ?? '',
    writingStyleChoice: writingStyleVal.value as string,
  };
}

// Reduce a KnobSpec list to its current values map (override or default).
// Used at write-time / UI to render the current knob state. Not used by
// the ingestion pipeline directly; lives here for utility.
export function currentKnobValues(
  specs: ReadonlyArray<KnobSpec<string>>,
  overrides: Record<string, unknown> | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const v: KnobValueSpec<string> = resolveKnobValue(spec, overrides);
    out[spec.name] = v.value as string;
  }
  return out;
}
