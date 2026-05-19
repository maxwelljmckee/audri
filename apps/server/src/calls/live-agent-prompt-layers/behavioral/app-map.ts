// Behavioral / App Map — renders the user's knob catalog into a prompt
// segment that Live Agent reads. Tells Audri which knobs are tunable,
// what their values mean, the match_hints she can use to map natural-
// language phrasings to discrete values, and the current effective
// value of each knob.
//
// Sourced from `apps/server/src/calls/preload.ts → fetchKnobCatalog`,
// which walks the user's agents + their user_agent_settings overrides.
// The KnobSpec list itself lives in `@audri/shared/knobs/registry.ts`.
//
// When the segment is non-empty, Audri can:
//   - Recognize knob-mutation directives ("be more thorough" → mapping
//     to a knob value via match_hints)
//   - Confirm the change verbally (no tool call — settings specialist
//     captures from transcript)
//   - Detect contradictions between a new knob choice + an existing
//     custom_rules entry (e.g., "be more thorough" while a custom rule
//     says "default to terse")
//
// Empty when the user has no agents with declared knobs — the segment
// vanishes from the composed prompt entirely.

export interface AppMapKnob {
  agent_id: string;
  agent_name: string;
  agent_type: 'live' | 'ingestion';
  knob_name: string;
  knob_display_name: string;
  knob_description: string;
  current_value: string | boolean;
  current_value_display_name: string;
  values: Array<{
    value: string | boolean;
    display_name: string;
    description: string;
    match_hints: string[];
  }>;
}

export interface AppMapArgs {
  catalog: AppMapKnob[];
}

export function buildAppMap(args: AppMapArgs): string {
  if (!args.catalog || args.catalog.length === 0) return '';

  // Group by agent so the user can see all of an agent's knobs together.
  const byAgent = new Map<string, AppMapKnob[]>();
  for (const k of args.catalog) {
    const list = byAgent.get(k.agent_id) ?? [];
    list.push(k);
    byAgent.set(k.agent_id, list);
  }

  const parts: string[] = [
    '# Tunable settings (App Map)',
    '',
    "The user can adjust the following settings on their agents. **These are STRUCTURED settings with discrete values** — distinct from the free-form `user_custom_rules` listed in the User customization rules section above. When the user states a directive that maps cleanly to one of these settings (e.g., \"be more thorough\" → an Intelligence value), recognize it as a setting change rather than a custom rule.",
    '',
    '## How to handle a setting-change directive',
    '',
    `1. **Match the user's phrasing to a setting + value** using the per-value \`match_hints\` listed below. Fuzzy match is fine — "thorough" / "deep" / "powerful" all point at the same High value.`,
    `2. **Confirm verbally** with the new value name. ("Got it — setting Rumi's Intelligence to High.")`,
    `3. **Check for contradiction with custom rules.** If a custom rule contradicts the new setting (e.g., user_custom_rules says "default to terse" and the user just asked for "more thorough explanations"), surface it per the contradiction-resolution flow in the Customization workflow section above.`,
    `4. **Don't invoke a tool.** The **post-call settings specialist** captures the change from your verbal confirmation; the user_agent_settings table updates after the call ends.`,
    '',
    "## When the user's intent is ambiguous between setting + rule",
    '',
    `If a directive could be either a discrete setting change OR a free-form rule (e.g., "always cite sources" — there's no \`cite_sources\` knob, so it lands as a custom rule), prefer the rule path. Settings are for KNOWN discrete options; rules are for everything else.`,
    '',
    '## When the user names a setting that doesn\'t exist',
    '',
    `If the user asks for a setting that's not in the catalog below (e.g., "set Rumi's font size to 14pt"), don't fabricate a knob. Either: (a) treat the directive as a custom rule if it makes sense as one, or (b) tell the user the setting doesn't exist and offer the nearest available adjustment.`,
    '',
    '## Available settings',
    '',
  ];

  for (const [agentId, knobs] of byAgent) {
    if (knobs.length === 0) continue;
    const head = knobs[0];
    if (!head) continue;
    parts.push(`### ${head.agent_name} (\`${head.agent_type}\`)`);
    parts.push(`*agent_id: \`${agentId}\`*`);
    parts.push('');
    for (const k of knobs) {
      parts.push(
        `- **${k.knob_display_name}** (\`${k.knob_name}\`) — ${k.knob_description}`,
      );
      parts.push(`  - **Current value:** ${k.current_value_display_name} (\`${String(k.current_value)}\`)`);
      parts.push(`  - **Available values:**`);
      for (const v of k.values) {
        const hintsBlock =
          v.match_hints.length > 0
            ? ` _Match hints: ${v.match_hints.map((h) => `"${h}"`).join(', ')}_`
            : '';
        parts.push(
          `    - \`${String(v.value)}\` (${v.display_name}): ${v.description}${hintsBlock}`,
        );
      }
    }
    parts.push('');
  }

  return parts.join('\n');
}
