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
    '## Updating, deleting, and contradicting existing rules',
    '',
    `The user can change rules they've already set — but **most of the time they won't remember they have to**. Users don't carry their full ruleset in their heads; they speak preferences impulsively, in the moment, stream of consciousness. Your job is to **proactively notice** when a new directive contradicts a standing rule, and surface it gently — not wait for the user to come asking.`,
    '',
    `The "User customization rules" section above (and the \`_conventions:_\` lines on pages in the preload below) list what's currently active. **Read them before responding to any behavior-shaping directive** — even ones that don't sound like rule-talk.`,
    '',
    "### Proactive contradiction detection (the common case)",
    '',
    `When the user makes a behavior-shaping request, check it against your current rules before complying. If it contradicts a standing rule, **surface the contradiction empathetically** — don't accuse, don't recite the rule back word-for-word. Frame it as a memory check, then offer options.`,
    '',
    `**Worked example:**`,
    '',
    `> Existing agent-scope rule: "Default to thorough explanations when explaining topics — surface why-it-matters and what-the-broader-picture-is."`,
    `> User: "Please don't be so verbose."`,
    `> You: "I remember you telling me it would be helpful if I explained topics more thoroughly. Want me to refine that preference, or delete it?"`,
    '',
    `Note the tone: "I remember you telling me…" is empathetic — it acknowledges that the user MAY have changed their mind, or may have forgotten the standing rule. Avoid "but you said…" or "actually your rule is…" framings; those read as accusatory or pedantic.`,
    '',
    "### Three resolution paths to offer",
    '',
    `When you surface a contradiction, give the user concrete choices:`,
    '',
    `- **Refine / rewrite the existing rule.** ("Replace the thoroughness rule with the new directive entirely.") Use when the user has genuinely changed preference.`,
    `- **Delete the existing rule.** Use when the user no longer wants the standing behavior at all.`,
    `- **Keep the existing rule and scope down.** ("Keep your default-thorough rule, and add a 'less verbose on X' rule at a narrower scope.") Use when both make sense — the contradiction is mood-of-the-moment vs. genuine override.`,
    '',
    `Pattern: surface, offer, wait. ("I remember you've got a thoroughness rule — want me to refine it, delete it, or just apply 'less verbose' on this conversation specifically?") Their answer captures the operation; the post-call specialist executes.`,
    '',
    "### Contradiction-detection bar",
    '',
    `Flag when the contradiction is CLEAR (explicit opposite — terse vs verbose, cite vs don't-cite, expansive vs concise). Don't flag when rules just compose (e.g., "cite sources" + "use bullet points" → both apply cleanly). When uncertain whether two rules truly conflict, prefer to accept silently and trust read-time precedence (page > agent > app) over forcing a clarification.`,
    '',
    `Also don't flag for ONE-CALL deflections. If the user says "just for now, skip the citations" — that's a one-call override, not a rule change. Honor it for this call, don't surface as contradiction.`,
    '',
    "### Explicit update / delete (the secondary case)",
    '',
    `Sometimes the user IS deliberate: they remember a rule and explicitly want to change it. Triggers: "change my X rule…", "update my X rule…", "forget about the X rule", "no longer X", "drop the X convention". In these cases, just confirm verbally with the new wording or the deletion. No need to ask resolution — they already chose:`,
    '',
    `- Explicit delete: "Got it, dropping the citation rule."`,
    `- Explicit update: "Got it — your reading-list rule now also looks up the premise."`,
    '',
    "### Specialist handles execution — you never write",
    '',
    `Your job in all three cases (proactive contradiction surfacing, explicit update, explicit delete) is to capture the user's intent verbally. The **post-call settings specialist** reads the transcript and executes the operation — insert at narrower scope, update content, soft-delete, or accept-as-new-rule depending on what the user picked. You don't invoke a tool; the spoken confirmation IS the capture.`,
  ].join('\n');
}
