// Rumi (ingestion agent) knob declarations.
//
// Three knobs covering the cost / intelligence / speed axes for the
// ingestion pipeline:
//   - writing_style: output shape (Concise / Faithful / Structured / Enhanced)
//   - model_intelligence: model tier selection (Low / Adaptive / High)
//   - model_reasoning: Gemini thinking_config.reasoning_effort
//
// All three render as left→right sliders in the Notes Settings drawer
// (per spec § Open Question A: Rumi knobs surface under Notes Settings,
// not as a first-class agent in the Agents tile).

import { type KnobSpec, validateKnobSpec } from './spec.js';

export const RUMI_WRITING_STYLE: KnobSpec<string> = {
  name: 'writing_style',
  display_name: 'Writing Style',
  description: 'How Rumi shapes your voice notes into wiki content.',
  applies_to: ['ingestion'],
  type: 'enum',
  kind: 'prompt',
  default: 'structured',
  user_visible: true,
  mutator_endpoint: 'PUT /agents/:agent_id/knobs/writing_style',
  values: [
    {
      value: 'concise',
      display_name: 'Concise',
      description: 'Minimalist language; favors bulleted lists over prose.',
      match_hints: ['be concise', 'short notes', 'minimal', 'terse notes'],
      prompt_injection:
        'When writing wiki sections, favor terse, minimalist phrasing and bulleted lists over prose. Prefer fewer words; do not embellish.',
    },
    {
      value: 'faithful',
      display_name: 'Faithful',
      description: "Stays close to the user's own language; minimal rewriting.",
      match_hints: ['stay close to my words', 'faithful', 'verbatim', 'no rewriting'],
      prompt_injection:
        "When writing wiki sections, preserve the user's phrasing and vocabulary closely; minimal rewriting beyond removing filler words and conversational scaffolding.",
    },
    {
      value: 'structured',
      display_name: 'Structured',
      description:
        "Reframes stream-of-consciousness into complete sentences and logical structure. (Default.)",
      match_hints: ['structured', 'organized', 'rewrite into prose', 'clean it up'],
      prompt_injection:
        "When writing wiki sections, reshape the user's stream-of-consciousness into complete prose sentences with logical flow. Group related thoughts; preserve substance while improving structure.",
    },
    {
      value: 'enhanced',
      display_name: 'Enhanced',
      description: "Adds grounded background research and context to supplement the user's thoughts.",
      match_hints: ['embellished', 'enhanced', 'add context', 'add research', 'enrich my notes'],
      prompt_injection:
        "When writing wiki sections, supplement the user's content with grounded background research on the topics discussed. Add context that helps the user revisit the topic later — historical background, related concepts, key figures, contextual framing. Cite sources for added content via cited_urls.",
    },
  ],
};

// Model intelligence selects the model tier used for Pro fan-out.
// 'adaptive' is the smart-default: a complexity classifier in the worker
// decides per-transcript whether to escalate to Pro. Implementation
// shipped alongside this knob in v0.4.0; classifier signal sources are
// transcript length + Flash candidate-set size + presence of
// cross-page / convention-setting directives.
//
// api_config carries the model name; the actual model selection happens
// in `runFanOut` based on the resolved value (adaptive → classifier).
// The api_config.model field is a hint for non-adaptive values; the
// adaptive value's api_config carries `{ model: 'adaptive' }` as a
// sentinel that the worker recognizes.
export const RUMI_MODEL_INTELLIGENCE: KnobSpec<string> = {
  name: 'model_intelligence',
  display_name: 'Model Intelligence',
  description:
    'How smart the ingestion model is. Adaptive (default) picks Flash or Pro per-transcript based on complexity.',
  applies_to: ['ingestion'],
  type: 'enum',
  kind: 'api_config',
  default: 'adaptive',
  user_visible: true,
  mutator_endpoint: 'PUT /agents/:agent_id/knobs/model_intelligence',
  values: [
    {
      value: 'low',
      display_name: 'Low',
      description: 'Always use Flash. Fastest + cheapest; weaker on complex routing.',
      match_hints: ['flash', 'fast', 'cheap', 'low intelligence'],
      api_config: { model: 'gemini-2.5-flash' },
    },
    {
      value: 'adaptive',
      display_name: 'Adaptive',
      description:
        'Smart default. A complexity classifier picks Flash for simple captures and Pro for complex transcripts (cross-page, convention-setting, long).',
      match_hints: ['adaptive', 'smart', 'auto', 'default'],
      api_config: { model: 'adaptive' },
    },
    {
      value: 'high',
      display_name: 'High',
      description: 'Always use Pro. Strongest routing + reasoning; slower + more expensive.',
      match_hints: ['pro', 'high intelligence', 'best', 'powerful'],
      api_config: { model: 'gemini-3.1-pro-preview' },
    },
  ],
};

// Model reasoning maps to Gemini's thinking_config.reasoning_effort. Only
// meaningful on the Pro path — Flash has no reasoning_effort parameter.
// The UX hides this knob when model_intelligence='low' (visible_when
// predicate); the value persists on the agent row regardless so that
// switching back to 'adaptive' or 'high' restores the user's preference.
export const RUMI_MODEL_REASONING: KnobSpec<string> = {
  name: 'model_reasoning',
  display_name: 'Reasoning Depth',
  description:
    'How deeply Rumi reasons during note ingestion. Higher = better edge-case handling, slower + more expensive. Only applies when Model Intelligence is Adaptive or High (Flash has no reasoning param).',
  applies_to: ['ingestion'],
  type: 'enum',
  kind: 'api_config',
  default: 'medium',
  user_visible: true,
  mutator_endpoint: 'PUT /agents/:agent_id/knobs/model_reasoning',
  visible_when: (vals) => vals.model_intelligence !== 'low',
  values: [
    {
      value: 'low',
      display_name: 'Low',
      description: 'Fastest, minimal reasoning depth.',
      match_hints: ['low reasoning', 'shallow'],
      api_config: { thinking_config: { reasoning_effort: 'low' } },
    },
    {
      value: 'medium',
      display_name: 'Medium',
      description: 'Balanced reasoning depth. (Default.)',
      match_hints: ['medium', 'balanced', 'default reasoning'],
      api_config: { thinking_config: { reasoning_effort: 'medium' } },
    },
    {
      value: 'high',
      display_name: 'High',
      description: 'Deeper reasoning; slower responses, better edge-case handling.',
      match_hints: ['high reasoning', 'deep reasoning', 'thoughtful'],
      api_config: { thinking_config: { reasoning_effort: 'high' } },
    },
    {
      value: 'xhigh',
      display_name: 'Very High',
      description: 'Maximum reasoning depth. Significantly slower + more expensive.',
      match_hints: ['xhigh', 'very high', 'maximum reasoning', 'extra deep'],
      api_config: { thinking_config: { reasoning_effort: 'xhigh' } },
    },
  ],
};

export const RUMI_KNOBS: ReadonlyArray<KnobSpec<string>> = [
  RUMI_WRITING_STYLE,
  RUMI_MODEL_INTELLIGENCE,
  RUMI_MODEL_REASONING,
];

// Validate at module-load time. Misconfigured knobs fail the build, not
// runtime mid-call.
for (const spec of RUMI_KNOBS) {
  validateKnobSpec(spec);
}
