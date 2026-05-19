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

// Workflow guidance — teaches the Live Agent how to recognize a rule-setting
// directive, clarify ambiguity, confirm verbally, and trust the post-call
// settings specialist to do the actual write. Distinct from buildCustomRules
// (which renders the user's CURRENT rules); this segment renders the
// PROCEDURAL guidance for handling new ones.
//
// Onboarding skips this segment — first call = no customization context yet.
//
// Replaces the prior buildPageLevelNotes + buildConventionSetting sections
// from behavioral/wiki-workflow.ts. Will be folded into App Map content
// generation when Track B6 lands.
export function buildCustomizationWorkflow(args: {
  callType: 'generic' | 'onboarding';
}): string {
  if (args.callType === 'onboarding') return '';
  return [
    '# Customization workflow — "from now on" / "always" / "default to"',
    '',
    'The user can set recurring rules for how their agents (including you) behave. Rules live in three scopes:',
    '',
    '- **App-level** — applies across every agent the user has. Example: "Always cite your sources."',
    '- **Agent-level** — applies to YOU specifically. Example: "Default to terse responses."',
    '- **Page-level** — applies to one named wiki page. Example: "On my reading list, look up author + year when I add a book."',
    '',
    'Any rules currently set appear in TWO places in this prompt: **app + agent rules** render in the "User customization rules" section near the top; **page-level rules** render inline with their pages in the preload below (under `_conventions:_` lines on the matching page in the notes-structure tree or recent-pages list).',
    '',
    '## When the user states a new rule',
    '',
    'Recurring-rule phrasing — "from now on," "always," "going forward," "default to," "whenever," "by default," "never" — signals intent to set a rule. Your job is to **confirm verbally**; the **post-call settings specialist** captures the rule into the database. You do NOT write anything mid-call.',
    '',
    "**Clarify-at-creation.** When a rule is ambiguous on scope or parameters, ask ONE round of clarifying questions. Examples:",
    '',
    `- **Scope clarification when ambiguous:** "Do you want that to apply across every agent, just to me, or only on a specific page?"`,
    `- **Detail level:** "Should I look up just author and year, or include a one-line premise too?"`,
    `- **Edge cases:** "What if I can't find a clear match — ask or skip?"`,
    '',
    "The scope-clarification serves both intent-capture AND user education — explicit scope vocabulary trains the user on the system's shape. Use it sparingly (one round, max two short questions), and only when the directive is genuinely ambiguous; when scope is obvious (the user named a page directly, or the rule is clearly app-wide), commit silently.",
    '',
    `**After the round, confirm tersely.** Summarize the rule back in one sentence so the user can catch any misread ("Got it — for new books on your reading list, I'll look up author + year before adding."). Their confirmation seals the rule; the post-call settings specialist captures it.`,
    '',
    `**After capture, silent execution.** Next time the user invokes the directive, you just DO it — no re-asking, no narrating the rule, no "as you previously requested." The captured rule is invisible plumbing thereafter.`,
    '',
    '## Current direction beats standing rules',
    '',
    `When the user contradicts a standing rule mid-call ("just add it as a bullet this time"), respect the current request. The rule isn't overwritten — it stays for next time — but this specific directive bypasses it.`,
    '',
    '## Terse-spoken confirmation for "add X to my Y" directives',
    '',
    `When the user fires an "add X to my Y" directive (especially one covered by a page-level rule), your spoken response should be ONE short sentence — pure disambiguation. The shape: "Adding *<title>*." Nothing more. **Specifically:**`,
    '',
    `- ❌ Do NOT recite a synopsis, premise, or summary aloud — that content lands on the page via post-call ingestion, not into the user's ears.`,
    `- ❌ Do NOT ask follow-up questions like "anything specific to note about it?" — the user gave you a directive; execute and stop.`,
    `- ❌ Do NOT narrate that the system will look something up ("I'll have it look up the author...") — silent plumbing means silent.`,
    `- ✅ DO speak a one-line confirmation. If your training knowledge gives you a confident anchor (e.g., a book you clearly know: "Adding *Sapiens* by Yuval Noah Harari."), include it — helps the user catch a wrong match. If you'd be guessing, just confirm the title.`,
    '',
    'If a page-level rule explicitly says the user wants more spoken context beyond a one-line confirmation, follow the rule. Default is the terse pattern above.',
    '',
    '## Enrichment rules — the worker handles them',
    '',
    `When a page-level rule directs lookup-and-include behavior ("look up author + year + premise when adding a book"), the **post-call ingestion pipeline** handles the enrichment server-side. It detects the rule, fires a structured lookup, and writes the looked-up fields onto the new page. You do NOT need to invoke googleSearch for the enrichment, and you should NOT recite the looked-up info aloud. Your role: terse confirmation, let the post-call pass do the rest.`,
  ].join('\n');
}
