// Accumulator for live-call tool activity. Captures two streams:
//
//   1. `groundingHits` — emissions from Gemini's built-in googleSearch
//      grounding. Each hit carries the web search queries the model ran
//      plus the source chunks (URI + title + domain) it cited. These are
//      pure signal otherwise discarded — the model uses them inline but
//      we lose the source attribution unless we record it here.
//
//   2. `customToolCalls` — invocations of our function tools (search_wiki,
//      fetch_page). Records the args the model passed and the response
//      that came back (success payload OR `{ error }`). Useful for
//      debugging weird agent behavior + future ingestion-side citation.
//
// Both blobs ship as a single `tool_calls` field on POST /calls/:id/end;
// server stores in `call_transcripts.tool_calls` (jsonb). Ingestion can
// later opt in to read these and write `wiki_section_urls` rows when
// agent-grounded statements get promoted to claims.

import { MediaModality } from '@google/genai';
import type {
  FunctionCall,
  FunctionResponse,
  GroundingMetadata,
  UsageMetadata,
} from '@google/genai';

export interface GroundingHit {
  ts: string;
  webSearchQueries?: string[];
  chunks: Array<{
    uri?: string;
    title?: string;
    domain?: string;
  }>;
}

export interface CustomToolCallRecord {
  ts: string;
  name: string;
  args: unknown;
  response: unknown;
}

export interface ToolCallLogPayload {
  groundingHits: GroundingHit[];
  customToolCalls: CustomToolCallRecord[];
  // Cumulative session usage, rebuilt as a synthetic UsageMetadata from
  // per-message increments. Field test 2026-05-12 disproved the earlier
  // assumption that Live emits cumulative values — each message carries
  // its OWN contribution (a single audio frame's response tokens, or a
  // turn's prompt cost at turn boundaries), so the correct aggregation
  // is a running sum across the session. Server uses this to write a
  // `call_live` usage_events row on /end. Undefined if no non-empty
  // UsageMetadata arrived (e.g. session ended before first turn).
  sessionUsage?: UsageMetadata;
}

export interface ToolCallLogHandle {
  recordGrounding: (metadata: GroundingMetadata) => void;
  recordCustomCalls: (calls: FunctionCall[]) => void;
  recordCustomResponses: (responses: FunctionResponse[]) => void;
  recordSessionUsage: (usage: UsageMetadata) => void;
  snapshot: () => ToolCallLogPayload;
  reset: () => void;
}

export function createToolCallLog(): ToolCallLogHandle {
  let groundingHits: GroundingHit[] = [];
  let customToolCalls: CustomToolCallRecord[] = [];
  // Per-modality running totals across all UsageMetadata events. Each
  // message contributes its own deltas; we accumulate. Thinking tokens
  // fold into responseText since Gemini bills thinking at the output-text
  // rate. Cached tokens accumulate separately so the cached-input
  // discount in computeCostCents still applies.
  const accum = {
    promptText: 0,
    promptAudio: 0,
    responseText: 0,
    responseAudio: 0,
    toolUsePromptText: 0,
    toolUsePromptAudio: 0,
    cached: 0,
  };
  let anyUsageSeen = false;
  // pendingByName lets us match responses back to their issuing call. We key
  // by id when available (id is the official correlator), falling back to
  // name + first-pending for the rare case the SDK omits id.
  const pendingById = new Map<string, CustomToolCallRecord>();

  // Walk a *TokensDetails array, summing into the per-modality slots.
  // Falls back to the flat field when details are absent.
  function addModality(
    details: { modality?: string; tokenCount?: number }[] | undefined,
    flatCount: number,
    audioSlot: 'promptAudio' | 'responseAudio' | 'toolUsePromptAudio',
    textSlot: 'promptText' | 'responseText' | 'toolUsePromptText',
  ): void {
    if (details && details.length > 0) {
      for (const d of details) {
        const n = d.tokenCount ?? 0;
        if (d.modality === 'AUDIO') accum[audioSlot] += n;
        else accum[textSlot] += n;
      }
      return;
    }
    if (flatCount > 0) accum[textSlot] += flatCount;
  }

  // Rebuild a UsageMetadata-shaped blob from the accumulator so the
  // server's existing tokenTotalsFromUsage / computeCostCents path can
  // process it unchanged.
  function buildCumulativeUsage(): UsageMetadata | undefined {
    if (!anyUsageSeen) return undefined;
    const totalPrompt = accum.promptText + accum.promptAudio;
    const totalToolUsePrompt = accum.toolUsePromptText + accum.toolUsePromptAudio;
    const totalResponse = accum.responseText + accum.responseAudio;
    const promptDetails = [
      ...(accum.promptText > 0
        ? [{ modality: MediaModality.TEXT, tokenCount: accum.promptText }]
        : []),
      ...(accum.promptAudio > 0
        ? [{ modality: MediaModality.AUDIO, tokenCount: accum.promptAudio }]
        : []),
    ];
    const responseDetails = [
      ...(accum.responseText > 0
        ? [{ modality: MediaModality.TEXT, tokenCount: accum.responseText }]
        : []),
      ...(accum.responseAudio > 0
        ? [{ modality: MediaModality.AUDIO, tokenCount: accum.responseAudio }]
        : []),
    ];
    const toolUseDetails = [
      ...(accum.toolUsePromptText > 0
        ? [{ modality: MediaModality.TEXT, tokenCount: accum.toolUsePromptText }]
        : []),
      ...(accum.toolUsePromptAudio > 0
        ? [{ modality: MediaModality.AUDIO, tokenCount: accum.toolUsePromptAudio }]
        : []),
    ];
    return {
      promptTokenCount: totalPrompt,
      responseTokenCount: totalResponse,
      toolUsePromptTokenCount: totalToolUsePrompt || undefined,
      cachedContentTokenCount: accum.cached || undefined,
      totalTokenCount: totalPrompt + totalToolUsePrompt + totalResponse,
      promptTokensDetails: promptDetails.length > 0 ? promptDetails : undefined,
      responseTokensDetails: responseDetails.length > 0 ? responseDetails : undefined,
      toolUsePromptTokensDetails: toolUseDetails.length > 0 ? toolUseDetails : undefined,
    };
  }

  return {
    recordGrounding: (metadata) => {
      const chunks = (metadata.groundingChunks ?? []).map((c) => ({
        uri: c.web?.uri,
        title: c.web?.title,
        domain: c.web?.domain,
      }));
      // Drop empty hits — common when grounding metadata fires for a turn
      // the model didn't actually search on.
      if (chunks.length === 0 && !metadata.webSearchQueries?.length) return;
      groundingHits.push({
        ts: new Date().toISOString(),
        webSearchQueries: metadata.webSearchQueries,
        chunks,
      });
    },
    recordCustomCalls: (calls) => {
      for (const c of calls) {
        const record: CustomToolCallRecord = {
          ts: new Date().toISOString(),
          name: c.name ?? '(unnamed)',
          args: c.args ?? {},
          response: null,
        };
        customToolCalls.push(record);
        if (c.id) pendingById.set(c.id, record);
      }
    },
    recordCustomResponses: (responses) => {
      for (const r of responses) {
        if (!r.id) continue;
        const pending = pendingById.get(r.id);
        if (pending) {
          pending.response = r.response;
          pendingById.delete(r.id);
        }
      }
    },
    recordSessionUsage: (usage) => {
      // Live emits per-message-incremental usage. Each prompt-bearing
      // message reports a turn's full prompt cost; each response-bearing
      // message reports one audio frame's output (1–10 tokens). Empty
      // `{}` messages fire at turn boundaries — skip those outright.
      // See field test 2026-05-12 logs for the discovery.
      const total = usage.totalTokenCount ?? 0;
      const thoughts = usage.thoughtsTokenCount ?? 0;
      if (total === 0 && thoughts === 0) return;
      anyUsageSeen = true;

      addModality(
        usage.promptTokensDetails,
        usage.promptTokenCount ?? 0,
        'promptAudio',
        'promptText',
      );
      addModality(
        usage.responseTokensDetails,
        usage.responseTokenCount ?? 0,
        'responseAudio',
        'responseText',
      );
      addModality(
        usage.toolUsePromptTokensDetails,
        usage.toolUsePromptTokenCount ?? 0,
        'toolUsePromptAudio',
        'toolUsePromptText',
      );
      // Thinking tokens are billed at the output-text rate on Live Flash;
      // fold into responseText so computeCostCents prices them correctly
      // without needing a dedicated field. Loss: thinking isn't visible
      // as a distinct line in usage_events — acceptable for v0.2.1.
      accum.responseText += thoughts;
      accum.cached += usage.cachedContentTokenCount ?? 0;
    },
    snapshot: () => ({
      groundingHits,
      customToolCalls,
      sessionUsage: buildCumulativeUsage(),
    }),
    reset: () => {
      groundingHits = [];
      customToolCalls = [];
      accum.promptText = 0;
      accum.promptAudio = 0;
      accum.responseText = 0;
      accum.responseAudio = 0;
      accum.toolUsePromptText = 0;
      accum.toolUsePromptAudio = 0;
      accum.cached = 0;
      anyUsageSeen = false;
      pendingById.clear();
    },
  };
}
