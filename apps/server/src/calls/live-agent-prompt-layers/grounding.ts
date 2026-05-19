// Grounding layer — retrieval results, enrichment lookups, tool outputs.
//
// **N/A for the Live Agent system prompt at compose time.** Live Agent
// receives tool results as new model turns mid-conversation, not as
// static prompt content. The layer exists for parity with the spec's
// 5-layer model and for future use cases where tool outputs might be
// pre-injected into the system prompt (none today).
//
// For comparison: Pro fan-out's prompt has substantial Grounding content
// (enrichment_lookups, grounding_sources, candidate_pages). When Rumi
// migrates to the layered architecture, Grounding will carry real
// content; for Live Agent it stays empty.

// biome-ignore lint/correctness/noUnusedFunctionParameters: keeps API parity with other layers
export function buildGrounding(_args: Record<string, never>): string {
  return '';
}
