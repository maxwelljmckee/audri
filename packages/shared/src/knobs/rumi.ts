// Rumi (ingestion agent) knob declarations.
//
// Two user-facing knobs on the cost / intelligence / speed axis for the
// ingestion pipeline:
//   - writing_style: output shape (Concise / Faithful / Structured / Enhanced)
//   - intelligence: combined model tier + reasoning depth (Low / Adaptive / High)
//
// `intelligence` is a USER-FACING abstraction over two underlying knobs
// (model tier + Gemini thinking_config.reasoning_effort). Three presets
// cover the useful space. The granular split — exposing model and
// reasoning_effort as separate sliders — is reserved for a future
// "Advanced Settings" UI when power users need finer control. For v0.4.0
// the public-facing surface stays simple.
//
// Both knobs render as left→right sliders in the Notes Settings drawer
// (per spec § Open Question A: Rumi knobs surface under Notes Settings,
// not as a first-class agent in the Agents tile).

import { type KnobSpec, validateKnobSpec } from "./spec.js";

export const RUMI_WRITING_STYLE: KnobSpec<string> = {
  name: "writing_style",
  display_name: "Writing Style",
  description: "How Rumi shapes your voice notes into wiki content.",
  applies_to: ["ingestion"],
  type: "enum",
  kind: "prompt",
  default: "structured",
  user_visible: true,
  mutator_endpoint: "PUT /agents/:agent_id/knobs/writing_style",
  values: [
    {
      value: "concise",
      display_name: "Concise",
      description: "Minimalist language; favors bulleted lists over prose.",
      match_hints: ["be concise", "short notes", "minimal", "terse notes"],
      prompt_injection:
        "When writing wiki sections, favor terse, minimalist phrasing and bulleted lists over prose. Prefer fewer words; do not embellish.",
    },
    {
      value: "faithful",
      display_name: "Faithful",
      description: "Stays close to the user's own language; minimal rewriting.",
      match_hints: [
        "stay close to my words",
        "faithful",
        "verbatim",
        "no rewriting",
      ],
      prompt_injection:
        "When writing wiki sections, preserve the user's phrasing and vocabulary closely; minimal rewriting beyond removing filler words and conversational scaffolding.",
    },
    {
      value: "structured",
      display_name: "Structured",
      description:
        "Organizes stream-of-consciousness thoughts into complete sentences and logical structure.",
      match_hints: [
        "structured",
        "organized",
        "rewrite into prose",
        "clean it up",
      ],
      prompt_injection:
        "When writing wiki sections, reshape the user's stream-of-consciousness into complete prose sentences with logical flow. Group related thoughts; preserve substance while improving structure.",
    },
    {
      value: "enhanced",
      display_name: "Enhanced",
      description:
        "Adds grounded background research and context to supplement the user's thoughts.",
      match_hints: [
        "embellished",
        "enhanced",
        "add context",
        "add research",
        "enrich my notes",
      ],
      prompt_injection:
        "When writing wiki sections, supplement the user's content with grounded background research on the topics discussed. Add context that helps the user revisit the topic later — historical background, related concepts, key figures, contextual framing. Cite sources for added content via cited_urls.",
    },
  ],
};

// Combined intelligence knob — abstracts model-tier + reasoning depth into
// a single user-facing slider. Three presets cover the useful 80% of the
// configuration space without forcing users to reason about model-vs-
// reasoning tradeoffs.
//
// Adaptive (the default) runs a complexity classifier in the worker per
// transcript and escalates to the higher-intelligence path when the
// transcript is long or touches many candidate pages. Classifier
// thresholds + signals live in apps/worker/src/ingestion/rumi-knobs.ts.
//
// api_config carries both `model` and `thinking_config` together; the
// worker reads the resolved value and applies model selection + reasoning
// effort in one pass. The `adaptive` value's `model` field is the
// sentinel string `'adaptive'`, which the worker recognizes and resolves
// to a concrete model name via the classifier.
//
// Power-user split: the underlying model-tier and reasoning-depth axes
// can be exposed as separate knobs in a future "Advanced Settings" UI.
// Code-level options for all reasoning values (low / medium / high /
// xhigh) and all model tiers remain available without schema changes —
// just declare additional KnobSpecs and add them to RUMI_KNOBS when the
// Advanced Settings surface lands.
export const RUMI_INTELLIGENCE: KnobSpec<string> = {
  name: "intelligence",
  display_name: "Intelligence",
  description:
    "How deeply Rumi thinks about your notes. Higher levels are slower and more expensive, but handle complex material better.",
  applies_to: ["ingestion"],
  type: "enum",
  kind: "api_config",
  default: "adaptive",
  user_visible: true,
  mutator_endpoint: "PUT /agents/:agent_id/knobs/intelligence",
  values: [
    {
      value: "low",
      display_name: "Low",
      description:
        "Fast and lightweight. Best for simple todos and short notes.",
      match_hints: [
        "low intelligence",
        "fast",
        "simple",
        "lightweight",
        "cheap",
      ],
      api_config: { model: "gemini-2.5-flash" },
    },
    {
      value: "adaptive",
      display_name: "Adaptive",
      description:
        "Recommended default. Quick on simple captures; engages deeper analysis for complex thoughts, synthesis, and cross-note connections.",
      match_hints: ["adaptive", "smart", "auto", "default", "balanced"],
      api_config: {
        model: "adaptive",
        thinking_config: { reasoning_effort: "medium" },
      },
    },
    {
      value: "high",
      display_name: "High",
      description:
        "Maximum thoroughness. Best for dense topics, deep synthesis, and complex connections across your notes.",
      match_hints: [
        "high intelligence",
        "thorough",
        "deep",
        "powerful",
        "maximum",
      ],
      api_config: {
        model: "gemini-3.1-pro-preview",
        thinking_config: { reasoning_effort: "high" },
      },
    },
  ],
};

export const RUMI_KNOBS: ReadonlyArray<KnobSpec<string>> = [
  RUMI_WRITING_STYLE,
  RUMI_INTELLIGENCE,
];

// Validate at module-load time. Misconfigured knobs fail the build, not
// runtime mid-call.
for (const spec of RUMI_KNOBS) {
  validateKnobSpec(spec);
}
