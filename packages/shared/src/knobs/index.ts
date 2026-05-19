// KnobSpec substrate + Rumi knob declarations. Re-exports the spec types
// and the concrete knob registry. See `spec.ts` for type definitions and
// `rumi.ts` for the v0.4.0 ingestion-agent knobs.

export type { AgentType, KnobSpec, KnobValueSpec } from './spec.js';
export { resolveKnobValue, validateKnobSpec } from './spec.js';
export { RUMI_INTELLIGENCE, RUMI_KNOBS, RUMI_WRITING_STYLE } from './rumi.js';
