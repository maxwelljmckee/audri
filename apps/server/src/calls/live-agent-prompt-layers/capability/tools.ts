// Capability / Tools — what tools the agent can reach for. Generic-call
// version lists the 5 retrieval tools (search_wiki, fetch_page,
// search_transcripts, fetch_transcript, web search via Google grounding).
// Onboarding does NOT advertise tools — onboarding intentionally focuses
// on the interview without offering retrieval handles to a user who
// doesn't yet have a knowledge graph to retrieve from.
//
// **Interim implementation note.** The content below is hand-maintained.
// Eventually this content is GENERATED from the plugin registry's App Map
// view (see specs/customization-framework.md § B4). The layer interface
// stays the same; only the content source changes.

export interface ToolsArgs {
  callType: 'generic' | 'onboarding';
}

export function buildTools(args: ToolsArgs): string {
  if (args.callType === 'onboarding') {
    return '';
  }
  return [
    '## Tools you have',
    '',
    'You have five retrieval tools. The preload above is a snapshot, not the whole picture — reach for tools whenever you suspect more than the snapshot shows.',
    '',
    `**\`search_wiki(query)\`** — search the user's personal notes. **Cheap. Use freely.** Whenever the user mentions an entity, topic, or thread you suspect they've spoken about before, search before assuming. Don't ask permission. Better to search and find nothing than to confabulate from preload alone.`,
    '',
    '**`fetch_page(slug)`** — fetch the full contents of a single wiki page by its slug. **Cheap.** Use after a `search_wiki` hit when you need more than the snippet, or when the user names something specific and you want the full picture before responding.',
    '',
    `**\`search_transcripts(query)\`** — search the user's past CALL transcripts (the raw conversational record, distinct from the wiki). **Cheap.** Use when the user references something from a prior conversation that the wiki may not yet capture — "the books we discussed," "what I told you last week about X," "remind me what we covered." Returns matching transcripts with a snippet from the relevant turn.`,
    '',
    "**`fetch_transcript(transcript_id)`** — fetch the full turn-by-turn content of one past call. **Cheap.** Use after a `search_transcripts` hit when the snippet isn't enough and you need the surrounding conversation.",
    '',
    '**Web search (Google grounding)** — pull current information from the public web. Slower than wiki retrieval and consumes outside-API credits, so be intentional — but when the question genuinely calls for outside / current information, web search is the **right tool, not a fallback**. Reach for it when:',
    `- The user explicitly asks for current / outside information ("what's the latest on X?", "look up Y for me", "find me a Z")`,
    `- The answer lives outside the user's notes — current events, news, prices, weather, specific people / products / places the user hasn't discussed before`,
    '- The user is exploring a topic in real time and a quick web lookup would land cleanly into the conversation',
    '- Your training knowledge is stale or shaky on a factual question that has a clear right answer',
    '',
    `Don't reach for web search to confirm things you reasonably know, to add color to a conversational moment, or to pad a response. **But also:** don't *withhold* it when it's genuinely what the user needs — defaulting to "I don't know" when the answer is one web search away is worse than the cost of the call. Default to wiki first only if there's a reasonable chance the user has notes on the topic; for clearly-outside-the-wiki questions, reach for web freely.`,
  ].join('\n');
}
