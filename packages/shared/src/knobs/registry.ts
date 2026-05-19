// Agent-knob registry — central mapping from agent_type → KnobSpec list.
// Single source of truth for "what knobs exist on which agent kind."
//
// The App Map projection (live-agent-prompt-layers/behavioral/app-map.ts)
// + settings specialist both consume this. Adding a knob set for a new
// agent type = add the constant import + the registry entry; downstream
// systems pick it up automatically.

import type { AgentType, KnobSpec } from './spec.js';
import { RUMI_KNOBS } from './rumi.js';

export const AGENT_KNOB_REGISTRY: Record<AgentType, ReadonlyArray<KnobSpec<string>>> = {
  // Audri (live) knobs land in a follow-on commit — empty for v0.4.0 first cut.
  live: [],
  ingestion: RUMI_KNOBS,
};

// Lookup helper. Returns empty array for unknown / not-yet-defined agent
// types so callers can iterate safely without null-checks.
export function knobsForAgentType(type: AgentType): ReadonlyArray<KnobSpec<string>> {
  return AGENT_KNOB_REGISTRY[type] ?? [];
}
