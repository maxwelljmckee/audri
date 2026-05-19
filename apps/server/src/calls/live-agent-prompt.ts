// Live-Agent prompt — public entrypoint. Composes the five-layer model
// defined in `specs/customization-framework.md` § "Prompt decomposition
// contract". The composition orchestrator + per-layer content live under
// `live-agent-prompt-layers/`.
//
// The legacy `composeSystemPrompt` name is preserved as an alias for
// backward compatibility with existing call sites
// (calls.service.ts + chat.service.ts). New call sites should use
// `composeLiveAgentPrompt` directly.

export {
  composeLiveAgentPrompt,
  composeLiveAgentPrompt as composeSystemPrompt,
  type ComposeLiveAgentPromptArgs,
} from './live-agent-prompt-layers/compose.js';
