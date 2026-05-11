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

import type { FunctionCall, FunctionResponse, GroundingMetadata } from '@google/genai';

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
}

export interface ToolCallLogHandle {
  recordGrounding: (metadata: GroundingMetadata) => void;
  recordCustomCalls: (calls: FunctionCall[]) => void;
  recordCustomResponses: (responses: FunctionResponse[]) => void;
  snapshot: () => ToolCallLogPayload;
  reset: () => void;
}

export function createToolCallLog(): ToolCallLogHandle {
  let groundingHits: GroundingHit[] = [];
  let customToolCalls: CustomToolCallRecord[] = [];
  // pendingByName lets us match responses back to their issuing call. We key
  // by id when available (id is the official correlator), falling back to
  // name + first-pending for the rare case the SDK omits id.
  const pendingById = new Map<string, CustomToolCallRecord>();

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
    snapshot: () => ({
      groundingHits,
      customToolCalls,
    }),
    reset: () => {
      groundingHits = [];
      customToolCalls = [];
      pendingById.clear();
    },
  };
}
