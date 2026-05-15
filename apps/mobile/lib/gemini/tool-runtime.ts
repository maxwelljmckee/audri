// Live-agent tool runtime. Receives tool-call batches from Gemini Live and
// fulfills them via the server's /calls/tools/* endpoints.
//
// Four custom tools today:
//   - search_wiki({ query }) → list of matching pages with snippets
//   - fetch_page({ slug }) → full page (title + abstract + sections)
//   - search_transcripts({ query }) → list of matching past calls + snippets
//   - fetch_transcript({ transcript_id }) → full turn list of one past call
//
// Gemini-native googleSearch grounding is also wired (server-side); it has
// no client fulfillment path — the model handles it internally during the
// generation, surfacing results inline.
//
// Every received FunctionCall MUST produce one FunctionResponse with the
// matching `id`, even on error — otherwise Gemini Live waits indefinitely.
// Errors are surfaced to the model as `{ error: '...' }` payloads so the
// model can recover gracefully ("Hmm, that didn't work, let me try X").

import type { FunctionCall, FunctionResponse } from '@google/genai';
import { captureClientError } from '../sentry';
import { supabase } from '../supabase';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export async function handleToolCalls(
  calls: FunctionCall[],
  reply: (responses: FunctionResponse[]) => void,
): Promise<void> {
  const responses = await Promise.all(calls.map(executeOne));
  reply(responses);
}

async function executeOne(call: FunctionCall): Promise<FunctionResponse> {
  const id = call.id;
  const name = call.name ?? '';
  // FunctionResponse.id is required for matching; FunctionResponse.name
  // is required too per the SDK type.
  const base = { id, name };

  try {
    if (name === 'search_wiki') {
      const args = (call.args ?? {}) as { query?: string };
      const data = await callApi('/calls/tools/search_wiki', { query: args.query ?? '' });
      return { ...base, response: { output: data } };
    }
    if (name === 'fetch_page') {
      const args = (call.args ?? {}) as { slug?: string };
      const data = await callApi('/calls/tools/fetch_page', { slug: args.slug ?? '' });
      return { ...base, response: { output: data } };
    }
    if (name === 'search_transcripts') {
      const args = (call.args ?? {}) as { query?: string };
      const data = await callApi('/calls/tools/search_transcripts', {
        query: args.query ?? '',
      });
      return { ...base, response: { output: data } };
    }
    if (name === 'fetch_transcript') {
      const args = (call.args ?? {}) as { transcript_id?: string };
      const data = await callApi('/calls/tools/fetch_transcript', {
        transcript_id: args.transcript_id ?? '',
      });
      return { ...base, response: { output: data } };
    }
    return {
      ...base,
      response: { output: { error: `unknown tool: ${name}` } },
    };
  } catch (err) {
    captureClientError('tool-call-failed', err, { toolName: name });
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      response: { output: { error: message } },
    };
  }
}

async function callApi(path: string, body: unknown): Promise<unknown> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('no auth session');
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
