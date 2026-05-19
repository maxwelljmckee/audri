// Behavioral / Custom rules — user-set NL behavioral rules that override
// or augment the default behavioral guidance. Sourced from `user_custom_rules`
// table (see specs/customization-framework.md § "NL customization architecture").
//
// Scope hierarchy: page > agent > app. Page-scope rules ride along inline
// with their pages in the preload block (`_conventions:_` lines under each
// page). App + agent scoped rules render here as a single Behavioral segment
// near the top of the agent's tactical guidance.
//
// Empty when no rules are set at either scope — segment vanishes from the
// composed prompt.

export interface CustomRulesArgs {
  agentName: string;
  appRules: string[];
  agentRules: string[];
}

export function buildCustomRules(args: CustomRulesArgs): string {
  if (args.appRules.length === 0 && args.agentRules.length === 0) {
    return '';
  }
  const parts: string[] = [
    '# User customization rules',
    '',
    'The user has set the following rules for how you should behave. These are part of how YOU work, on top of the principles above. **More specific rules override broader ones** — page-level rules (which appear inline with their pages in the preload below) override agent-level rules, which override app-level rules.',
  ];
  if (args.appRules.length > 0) {
    parts.push('', '## App-level (apply across every agent)');
    parts.push('');
    for (const rule of args.appRules) {
      parts.push(`- ${rule}`);
    }
  }
  if (args.agentRules.length > 0) {
    parts.push('', `## Agent-level (apply to YOU specifically — ${args.agentName})`);
    parts.push('');
    for (const rule of args.agentRules) {
      parts.push(`- ${rule}`);
    }
  }
  return parts.join('\n');
}
