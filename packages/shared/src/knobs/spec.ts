// KnobSpec — the typed-knob substrate of the customization framework.
// See specs/customization-framework.md § "Locked KnobSpec v2 shape".
//
// Knobs are agent-scope only (per spec § 1 LD1). Each KnobSpec declares
// a global default + value contract; user overrides live in
// `user_agent_settings.overrides` keyed by knob name. Reading a knob =
// override merged over default.
//
// Two value-consumption modes:
//   - kind: 'prompt'     — the chosen value's prompt_injection string is
//                           concatenated into the agent's prompt at the
//                           appropriate layer (Behavioral for most cases).
//   - kind: 'api_config' — the chosen value's api_config object is merged
//                           into the Gemini API call config / model
//                           selection.
//
// Knobs may also include a 'composite' mode that does both, but v0.4.0
// ships only enum + boolean (no composite, no numeric, no string — see
// spec for the deferral rationale).

export type AgentType = 'live' | 'ingestion';

export interface KnobValueSpec<TValue = string | boolean> {
  value: TValue;
  display_name: string;
  description: string;
  // Example user-phrases that should map to this value when Live Agent
  // does fuzzy-matching on a verbal customization request. Used by the
  // App Map projection that informs Live Agent which knobs are tunable.
  match_hints?: string[];
  // Required when the parent KnobSpec.kind === 'prompt'. The string is
  // injected into the agent's prompt verbatim when this value is active.
  prompt_injection?: string;
  // Required when the parent KnobSpec.kind === 'api_config'. The object
  // is merged into the Gemini API call config when this value is active.
  api_config?: Record<string, unknown>;
}

export interface KnobSpec<TValue = string | boolean> {
  // snake_case identifier. Used as the key in user_agent_settings.overrides.
  name: string;
  display_name: string;
  description: string;
  // Which agent types this knob is offered for. Knob declarations
  // reference TYPE (e.g. 'ingestion'), never agent.id or agent.name, so
  // renaming an agent doesn't break knob bindings (spec § 1 LD1).
  applies_to: AgentType[];
  type: 'enum' | 'boolean';
  kind: 'prompt' | 'api_config';
  values: KnobValueSpec<TValue>[];
  default: TValue;
  // Hide internal-only knobs from settings UI.
  user_visible: boolean;
  // PUT endpoint template for the per-knob mutator. Used by the App
  // Map ingestion-view rendering. Includes :agent_id placeholder for
  // scope-templated resolution at write time.
  mutator_endpoint: string;
  // Show this knob in the UI ONLY when this predicate evaluates true
  // against the current knob values. Optional; defaults to always visible.
  // Used by Rumi's `model_reasoning` knob to hide when `model_intelligence`
  // is `low` (Flash has no reasoning_effort param).
  visible_when?: (currentValues: Record<string, string | boolean>) => boolean;
}

// Validate a KnobSpec at registry-load time. Enforces kind→value-shape
// coherence (per spec § "Locked KnobSpec v2 shape" — implementation
// requirement). Throws on misconfiguration so the worker / server fails
// fast at startup rather than silently no-opping mid-call.
export function validateKnobSpec(spec: KnobSpec): void {
  if (spec.values.length === 0) {
    throw new Error(`KnobSpec '${spec.name}': must have at least one value`);
  }
  const valueSet = new Set<string | boolean>();
  for (const v of spec.values) {
    if (valueSet.has(v.value)) {
      throw new Error(`KnobSpec '${spec.name}': duplicate value '${v.value}'`);
    }
    valueSet.add(v.value);
    if (spec.kind === 'prompt' && typeof v.prompt_injection !== 'string') {
      throw new Error(
        `KnobSpec '${spec.name}' value '${v.value}': kind='prompt' requires prompt_injection`,
      );
    }
    if (spec.kind === 'api_config' && (!v.api_config || typeof v.api_config !== 'object')) {
      throw new Error(
        `KnobSpec '${spec.name}' value '${v.value}': kind='api_config' requires api_config object`,
      );
    }
  }
  if (!valueSet.has(spec.default)) {
    throw new Error(
      `KnobSpec '${spec.name}': default '${spec.default}' is not in the value set`,
    );
  }
  if (spec.type === 'boolean') {
    if (spec.values.length !== 2) {
      throw new Error(`KnobSpec '${spec.name}': type='boolean' must have exactly 2 values`);
    }
    if (!valueSet.has(true) || !valueSet.has(false)) {
      throw new Error(`KnobSpec '${spec.name}': type='boolean' values must be true + false`);
    }
  }
}

// Resolve a knob's effective value for a user: override (when present in
// user_agent_settings.overrides) merged over the KnobSpec default. Returns
// the KnobValueSpec entry — caller picks prompt_injection / api_config /
// display_name etc. from there. Returns null when the override value
// doesn't match any KnobSpec value (corrupt setting; log + fall back to
// default).
export function resolveKnobValue<TValue extends string | boolean>(
  spec: KnobSpec<TValue>,
  overrides: Record<string, unknown> | null | undefined,
): KnobValueSpec<TValue> {
  const overrideRaw = overrides?.[spec.name];
  if (overrideRaw !== undefined) {
    const matched = spec.values.find((v) => v.value === overrideRaw);
    if (matched) return matched;
    // Override exists but doesn't match any value — silently fall back to default.
    // (Caller can log if it wants telemetry on corrupt overrides.)
  }
  const defaultMatch = spec.values.find((v) => v.value === spec.default);
  if (!defaultMatch) {
    // Should be impossible after validateKnobSpec; defensive guard.
    throw new Error(`KnobSpec '${spec.name}': default value '${spec.default}' not found`);
  }
  return defaultMatch;
}
