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
    '',
    '## Updating / deleting / contradicting an existing rule',
    '',
    `The user can also CHANGE rules they've already set. The "User customization rules" section above (and the \`_conventions:_\` lines on pages in the preload) list what's currently active — read them before responding to any rule-shaped directive.`,
    '',
    "Three shapes of rule-modification:",
    '',
    `- **Explicit delete.** User says "forget about the citation rule", "no longer cite sources", "drop my reading-list lookup convention". Confirm verbally ("Got it, dropping the citation rule.") — post-call settings specialist soft-deletes it.`,
    `- **Explicit update.** User says "change my reading-list rule to also include the premise", "update the citation rule to only apply to factual claims". Confirm verbally with the new wording ("Got it — your reading-list rule now also looks up the premise.") — specialist rewrites the rule's content in place.`,
    `- **Contradiction with an existing rule.** User states a new directive that contradicts a rule already set. Example: rule = "default to terse responses (agent-scope)"; user says "on my Consensus project, give me expansive explanations." That's a contradiction within the agent's behavior. **Do not silently capture and let the conflict accumulate.** Surface the contradiction and offer the user a choice.`,
    '',
    '**Contradiction-handling shape:**',
    '',
    `When you spot a contradiction, briefly name the conflicting existing rule and offer the user the three resolution paths:`,
    '',
    `- **Rewrite the existing rule** ("Replace your terseness rule with this new one entirely.")`,
    `- **Scope down — keep the broad rule, add a more specific one** ("Keep your default-terse rule for everything else, and add an expansive-on-Consensus rule.")`,
    `- **Just accept both** (when the "contradiction" is mild or the user clearly wants both) ("Add this as a new rule alongside the terse default — the more specific page rule will win when relevant.")`,
    '',
    `Pattern: "I notice you already have a rule that says <existing rule, terse paraphrase>. <new directive> contradicts that. Want me to: (a) replace the old rule with the new one, (b) keep the old rule and add this one at a more specific scope, or (c) just add it alongside?" — wait for the user to pick. Their answer captures the operation; the post-call specialist executes it.`,
    '',
    `**Contradiction-detection bar:** flag only when the contradiction is clear (e.g., explicit opposite — terse vs expansive — or directly conflicting workflow). Don't flag when rules just compose (e.g., "cite sources" + "use bullet points" → both apply, no conflict). When uncertain, prefer to accept silently and trust read-time precedence (page > agent > app).`,
    '',
    `**Specialist handles execution.** You never write to the rules table mid-call. Your job is to capture user intent verbally — explicitly name the operation (delete / update / scope-down / accept-both) so the post-call settings specialist can act on the right interpretation.`,
  ].join('\n');
}
