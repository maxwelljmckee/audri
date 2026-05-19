// Live-Agent prompt composition orchestrator.
//
// Composes the five-layer model into a single prompt string. Per
// `specs/customization-framework.md` § "Prompt decomposition contract":
//
//   - Identity    — who the agent is + constitutional principles + persona
//   - Capability  — what tools/plugins the agent can reach for
//   - Behavioral  — how the agent should act (style, reasoning, tool use,
//                   wiki workflow, interview shape)
//   - Contextual  — per-call dynamic data (preload, modality)
//   - Grounding   — N/A for Live Agent at compose time (tool results land
//                   mid-conversation, not in the system prompt)
//
// The orchestrator decides the order segments fire in. For semantic
// equivalence with the previous monolithic composer, the segment order
// matches the pre-refactor output byte-for-byte. Future knob injections +
// NL rule injections plug in as additional segments without changing the
// existing seam.

import {
  buildBringSomething,
  buildConventionSetting,
  buildCustomRules,
  buildInterviewShape,
  buildModalityOverride,
  buildNotesStructure,
  buildOpening,
  buildPageLevelNotes,
  buildProgressWrap,
  buildReadingTheMoment,
  buildStyle,
  buildTodoAssociations,
  buildTodosCommitted,
  buildToolUse,
  buildTopics,
} from './behavioral/index.js';
import { buildAdvertisement, buildTools } from './capability/index.js';
import { buildPersona, buildPrinciples, buildWho } from './identity/index.js';
import { buildPreload } from './contextual.js';

export interface ComposeLiveAgentPromptArgs {
  agentName: string;
  personaPrompt: string;
  userPromptNotes: string | null;
  callType: 'generic' | 'onboarding';
  preloadBlock?: string;
  modality?: 'audio' | 'text';
  // App + agent scoped user_custom_rules rendered into the Behavioral layer.
  // Page-scope rules ride along inline with their pages in `preloadBlock`.
  // Omit or pass empty arrays when no rules are set — the segment vanishes.
  customRules?: {
    app: string[];
    agent: string[];
  };
}

export function composeLiveAgentPrompt(args: ComposeLiveAgentPromptArgs): string {
  if (args.callType === 'onboarding') {
    return composeOnboarding(args);
  }
  return composeGeneric(args);
}

// Generic-call segment ordering. Mirrors the original
// composeGenericScaffolding output structure.
function composeGeneric(args: ComposeLiveAgentPromptArgs): string {
  const modalityOverride = buildModalityOverride({
    callType: args.callType,
    modality: args.modality,
  });

  // Scaffolding-internal segments. Custom rules (when present) inject
  // RIGHT AFTER principles — user-set rules take precedence over the
  // default behavioral guidance below, and the LLM reads top-down.
  const customRulesSegment = buildCustomRules({
    agentName: args.agentName,
    appRules: args.customRules?.app ?? [],
    agentRules: args.customRules?.agent ?? [],
  });
  const scaffolding = [
    buildWho({ agentName: args.agentName, callType: args.callType }),
    '',
    buildStyle({ callType: args.callType, modality: args.modality }),
    '',
    buildReadingTheMoment({ callType: args.callType }),
    '',
    buildPrinciples({ callType: args.callType }),
    ...(customRulesSegment ? ['', customRulesSegment] : []),
    '',
    buildBringSomething({ callType: args.callType }),
    '',
    buildTools({ callType: args.callType }),
    '',
    buildToolUse({ callType: args.callType }),
    '',
    buildAdvertisement({ callType: args.callType }),
    '',
    buildNotesStructure({ callType: args.callType }),
    '',
    buildPageLevelNotes({ callType: args.callType }),
    '',
    buildConventionSetting({ callType: args.callType }),
    '',
    buildTodoAssociations({ callType: args.callType }),
    '',
    buildTodosCommitted({ callType: args.callType }),
  ].join('\n');

  const persona = buildPersona({
    personaPrompt: args.personaPrompt,
    userPromptNotes: args.userPromptNotes,
  });
  const preload = buildPreload({ preloadBlock: args.preloadBlock });

  return [
    modalityOverride,
    scaffolding,
    '',
    persona,
    preload ? `\n${preload}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Onboarding-call segment ordering. Mirrors the original
// composeOnboardingScaffolding output structure.
function composeOnboarding(args: ComposeLiveAgentPromptArgs): string {
  const modalityOverride = buildModalityOverride({
    callType: args.callType,
    modality: args.modality,
  });

  const scaffolding = [
    buildWho({ agentName: args.agentName, callType: args.callType }),
    '',
    buildStyle({ callType: args.callType, modality: args.modality }),
    '',
    buildOpening({ agentName: args.agentName, callType: args.callType }),
    '',
    buildInterviewShape({ agentName: args.agentName, callType: args.callType }),
    '',
    buildTopics({ agentName: args.agentName, callType: args.callType }),
    '',
    buildAdvertisement({ callType: args.callType }),
    '',
    buildProgressWrap({ agentName: args.agentName, callType: args.callType }),
    '',
    buildPrinciples({ callType: args.callType }),
  ].join('\n');

  const persona = buildPersona({
    personaPrompt: args.personaPrompt,
    userPromptNotes: args.userPromptNotes,
  });

  return [modalityOverride, scaffolding, '', persona]
    .filter(Boolean)
    .join('\n');
}
