// Contextual layer — per-call dynamic content. The preload block (profile +
// recent activity + page tree + per-page conventions) is rendered upstream
// by `renderPreloadBlock` and passed in as a single string; this layer
// just decides whether to emit it.
//
// Modality override is technically also contextual (depends on the request)
// but its rendered content is style-shifting, so it lives in
// behavioral/style.ts → buildModalityOverride. compose.ts pulls it from
// there to emit at the top of the prompt.

export interface ContextualArgs {
  preloadBlock?: string;
}

export function buildPreload(args: ContextualArgs): string {
  if (!args.preloadBlock) return '';
  return args.preloadBlock;
}
