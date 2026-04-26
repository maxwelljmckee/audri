# SPEC — Research task prompt + handler

Status: **draft** — decision rules locked; prompt-text drafting + worked examples + evals remain.

The research task is the only MVP plugin. When a user asks Muse to research a topic mid-call (or fan-out extracts a research-intent commitment from a transcript), an `agent_tasks` row is created with `kind='research'`. The Graphile worker picks it up, dispatches via the plugin registry to the research handler, which runs a Pro call with web grounding, validates output, and commits to `research_outputs`.

This SPEC specifies the registry entry, handler I/O contract, prompt decision rules, and output schema.

---

## Plugin registry entry

```ts
research: {
  kind: 'research',
  prompt: './research/system-prompt.md',
  handler: researchHandler,
  inputPayloadSchema: ResearchPayloadZ,
  outputSchema: ResearchOutputZ,
  capabilityDescription:
    "Perform web research on a topic and produce a structured report with citations. " +
    "Best for questions where the answer needs grounding in current web sources " +
    "(news, products, places, recent events, technical topics).",
  requiredConnectors: [],
  artifactKind: 'research',
  reingestsIntoWiki: false,         // V1+ flip if re-ingestion lands
  immutable: true,                  // research outputs not editable
  modelTier: 'pro',
  tokenBudget: 30_000,
  timeoutMs: 120_000,
  maxAttempts: 2,
  defaultPriority: 5,
}
```

---

## Input payload schema

```ts
type ResearchPayload = {
  query: string                     // user-stated research goal, free-form
  context_summary?: string          // brief context from the transcript that originated the request
  source_transcript_id?: string     // FK back to the originating call_transcript
  source_turn_id?: string           // turn where the user made the ask
  user_profile_brief?: {            // optional grounding from preload
    name?: string
    interests_summary?: string      // distilled from profile/interests page
  }
  preferred_depth?: 'overview' | 'detailed'   // MVP defaults to 'overview' if not specified
}
```

`query` is the only required field. Other fields enrich the prompt for personalization but aren't load-bearing.

---

## Output schema

```ts
type ResearchOutput = {
  query: string                              // echoes input query verbatim
  summary: string                            // 2–4 sentence executive summary
  findings: Array<{
    heading: string
    content: string                          // markdown, multi-paragraph allowed
    citation_indices: number[]               // 1-indexed into `citations` array
  }>
  citations: Array<{
    url: string
    title: string                            // page title from grounding metadata
    snippet: string                          // brief excerpt that anchors the citation
  }>
  follow_up_questions?: string[]             // 2–4 questions the research surfaced; for the user to consider next
  notes_for_user?: string                    // any caveats, gaps, or "couldn't find" notes
}
```

Validated post-handler against `ResearchOutputZ` (zod). Validation failure → `ValidationError` (fail-fast per §11 Chunk 3 error handling).

---

## Decision rules (the prompt's job)

### Use web grounding aggressively for research-style queries

Research queries are exactly when the model SHOULD use web grounding. Conservative posture from §8 Chunk 4 is for general call conversation; here we want the model to ground claims in current sources.

Prompt instruction: *"This is a research task. Use Gemini's grounded search liberally — better to over-ground a claim than to assert without sources. Every substantive finding should be backed by at least one citation."*

### Citation discipline

- Every `findings[].content` makes at least one cited claim
- `citation_indices` reference the global `citations` array (1-indexed; 0 reserved for "no citation")
- Don't fabricate citations — if grounded search returned nothing useful, `notes_for_user` should say so explicitly
- Domain diversity preferred where possible (don't cite the same source 5 times if alternatives exist)

### Length + depth

Default depth = `'overview'`:
- Summary: 2–4 sentences
- Findings: 3–6 headings, ~150–300 words each
- Total output: ~1,500–2,500 words

`'detailed'`:
- Summary: 4–6 sentences
- Findings: 5–10 headings, ~250–500 words each
- Total output: ~3,500–5,000 words

Stay within `tokenBudget` (30k input/output combined).

### Voice + style

- Direct + factual; no hype
- Acknowledge uncertainty where present
- Don't roleplay the persona — this is the research handler, not a call-agent. Output is for the user to read post-task, not part of a conversation.
- No personalization beyond what `user_profile_brief` directly informs

### Skip / refuse criteria

- **Out-of-scope queries** — if the query isn't actually researchable (e.g., "research my own goals"), output a `notes_for_user` explaining why and produce no findings.
- **Harmful queries** — standard safety rails. Refuse + `notes_for_user` explanation.
- **Queries requiring private data** — if the query implies access to user's email/calendar/etc. that the research handler doesn't have, output explains the gap.

### Source attribution flow

Per §11 Chunk 3 source attribution: handler returns `{ output, sources }` where `sources` is a tagged union. For research, sources are typed as `{ kind: 'url', url, snippet }` for each unique citation. Backend writes them to `research_output_sources` at commit time.

If the research drew on existing wiki pages (via `search_wiki` or `fetch_page` tool calls), include them as `{ kind: 'wiki_ancestor', ancestorPageId, snippet }`. Backend writes to `research_output_ancestors`.

### Tool palette during the handler

The research handler's LLM call has access to:
- Gemini Live's grounded search (built-in, MVP)
- `search_wiki` (the user's own wiki — for context grounding)
- `fetch_page` (specific wiki page contents)

No `search_google` custom tool at MVP (deferred V1+ when we migrate off built-in grounding).

---

## Handler implementation outline

```ts
async function researchHandler(ctx: HandlerContext): Promise<HandlerReturn> {
  const payload = ctx.entry.inputPayloadSchema.parse(ctx.task.payload)
  const systemPrompt = await loadPromptFile(ctx.entry.prompt)

  // Compose the LLM call: system prompt + payload + user_profile_brief
  const llmResponse = await ctx.llm.generateContent({
    system: systemPrompt,
    user: composeResearchUserMessage(payload),
    tools: ['search_wiki', 'fetch_page'],
    grounding: { google_search: { enabled: true } },
    signal: ctx.signal,
  })

  // Parse + validate
  const output = ctx.entry.outputSchema.parse(JSON.parse(llmResponse.text))

  // Compose sources from output.citations + any wiki tool-call results captured during the call
  const sources: HandlerSource[] = [
    ...output.citations.map(c => ({ kind: 'url', url: c.url, snippet: c.snippet })),
    ...llmResponse.wiki_tool_results.map(r => ({
      kind: 'wiki_ancestor',
      ancestorPageId: r.page_id,
      snippet: r.snippet,
    })),
  ]

  return {
    output,
    sources,
    reingestIntoWiki: false,        // MVP: never re-ingest research; V1+ may flip
  }
}
```

Backend's commit helper writes:
- `research_outputs` row with `query, findings (jsonb), summary, agent_tasks_id, generated_at, model_used, tokens_in, tokens_out`
- `research_output_sources` rows (per URL citation)
- `research_output_ancestors` rows (per wiki page drawn from)
- Updates `agent_tasks.status='succeeded'`, `result_artifact_kind='research'`, `result_artifact_id=<new uuid>`
- Reparents the originating todo wiki page from `todos/todo` → `todos/done`
- Writes `wiki_log` `task` event

---

## Open / deferred

- **Re-ingestion of research findings into wiki** — V1+ per `reingestsIntoWiki: false` at MVP.
- **`'detailed'` depth** — supported in schema but rarely invoked at MVP; users get `'overview'` by default.
- **Multi-step research** (research → review → deeper research on subset) — V1+ if research quality demands iterative refinement.
- **Streaming partial results** — handler returns single JSON at end (per §11 Chunk 3); streaming progress to UI deferred per §11 Chunk 5.

---

## Related decisions

- `todos.md` §11 — plugin registry, handler contract, agent_tasks shape
- `todos.md` §3 — `research_outputs` table shape + per-kind source/ancestor junctions
- `todos.md` §8 Chunk 4 — Gemini Live grounded search at MVP (informs handler's tool palette)
- `tradeoffs.md` — re-ingestion off at MVP, transactional-commit idempotency, conservative retry posture
