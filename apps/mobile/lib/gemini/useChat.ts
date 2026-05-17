// Text-chat orchestrator. Lifts the chat session out of useCall so the
// voice hook can stay focused on Live API + audio plumbing, and chat
// can own its own much-simpler request/response loop.
//
// Lifecycle: start() → POST /chat/start → ready for sendUserText.
//   sendUserText(text) → POST /chat/turn → stream chunks into the
//     in-progress agent bubble → finalize on stream end.
//   end() → POST /calls/:id/end → ingestion pipeline (same as voice).
//
// Tools (search_wiki / fetch_page / search_transcripts / fetch_transcript
// / web_search) all fulfill server-side inside /chat/turn — the client
// only sees the streamed agent text. No client-side tool round-trips.

import { fetch as expoFetch } from 'expo/fetch';
import { useCallback, useEffect, useRef, useState } from 'react';
import { captureClientError } from '../sentry';
import { supabase } from '../supabase';
import { useChatStore } from '../useChatStore';
import { type TranscriptTurn, createTranscript } from './transcript';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

// Belt-and-suspenders cleanup for the streamed chat body. Today (RN
// 0.81 + expo/fetch + iOS 26) URLSession strips SSE framing from
// text/event-stream responses before JS sees them — so we just append
// the decoded chunks as plain text. But if a future platform update
// stops stripping, raw `data: ` / `event: …` / `:` comment lines could
// leak through. This filter handles both cases: when framing is absent
// (the common case), the chunk passes through unchanged; when it's
// present, the wrapper lines are stripped and only the inner data
// payload survives.
function stripStraySseFraming(chunk: string): string {
  if (!chunk) return '';
  // Fast path: no SSE markers anywhere in the chunk — return as-is.
  if (!chunk.includes('data:') && !chunk.startsWith(':') && !chunk.includes('event:')) {
    return chunk;
  }
  const out: string[] = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith(':')) continue; // SSE comment
    if (line.startsWith('event:')) continue; // event-name line (we don't act on event types client-side)
    if (line.startsWith('data: ')) {
      out.push(line.slice(6));
    } else if (line.startsWith('data:')) {
      out.push(line.slice(5));
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

interface StartChatResponse {
  sessionId: string;
}

export interface UseChatResult {
  start: () => Promise<void>;
  // Returns true if /calls/:id/end posted successfully (or there was
  // nothing to post). False = post failed and the session is marked
  // dropped; caller should NOT auto-route — let the user see the error.
  end: () => Promise<boolean>;
  // Append a user turn locally + POST it to /chat/turn, streaming the
  // agent response back into streamingAgentText until the stream closes.
  sendUserText: (text: string) => Promise<void>;
  transcript: TranscriptTurn[];
  // In-progress agent text (renders as the live bubble below the
  // finalized turns). Empty between turns.
  streamingAgentText: string;
  // True from the moment a chat-turn request is dispatched until the
  // first agent text chunk arrives (or the turn fails / aborts). The
  // chat screen uses this to render an agent-side typing indicator
  // during the wait — iOS URLSession coalesces our SSE chunks so the
  // model's response usually lands as a single waterfall delivery
  // after a few seconds of silence, and the indicator covers that gap.
  pendingAgentResponse: boolean;
  error: string | null;
}

export function useChat(): UseChatResult {
  const sessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<Date | null>(null);
  const transcriptRef = useRef(createTranscript());
  // AbortController for the in-flight chat-turn fetch. Held at hook
  // scope so end() / a new turn can cancel a prior streaming response —
  // otherwise the server keeps emitting tokens nobody will read until
  // the underlying socket closes.
  const chatAbortRef = useRef<AbortController | null>(null);

  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [streamingAgentText, setStreamingAgentText] = useState('');
  const [pendingAgentResponse, setPendingAgentResponse] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTranscript = useCallback(() => {
    setTranscript(transcriptRef.current.getAll());
    setStreamingAgentText(transcriptRef.current.getStreamingAgentText());
  }, []);

  const teardown = useCallback(() => {
    chatAbortRef.current?.abort();
    chatAbortRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(async () => {
    setError(null);
    transcriptRef.current.reset();
    setTranscript([]);
    setStreamingAgentText('');
    setPendingAgentResponse(false);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const jwt = sessionData.session?.access_token;
      if (!jwt) throw new Error('not signed in');

      const r = await expoFetch(`${API_URL}/chat/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ agent_slug: 'assistant' }),
      });

      if (!r.ok) {
        const bodyText = await r.text().catch(() => '');
        if (r.status === 402) {
          throw new Error(`SPEND_CAP_EXCEEDED ${bodyText}`);
        }
        throw new Error(`chat start failed: ${r.status} ${bodyText}`);
      }

      const { sessionId } = (await r.json()) as StartChatResponse;
      sessionIdRef.current = sessionId;
      startedAtRef.current = new Date();
      useChatStore.getState().markConnected();
    } catch (err) {
      captureClientError('chat-start-failed', err, {
        sessionId: sessionIdRef.current,
      });
      setError(err instanceof Error ? err.message : String(err));
      useChatStore.getState().markDropped();
    }
  }, []);

  const sendUserText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;

      transcriptRef.current.appendUserText(trimmed);
      refreshTranscript();

      // History excludes the user turn we just appended (goes on the
      // wire as `user_text`). The server rebuilds Gemini's contents
      // array per turn — no tool-call history needed.
      const turns = transcriptRef.current.getAll();
      const historyTurns = turns.slice(0, -1).map((t) => ({ role: t.role, text: t.text }));

      // Cancel any prior in-flight turn before starting a new one.
      // Two turns shouldn't race the same agent buffer.
      chatAbortRef.current?.abort();
      const controller = new AbortController();
      chatAbortRef.current = controller;
      // Agent-side typing indicator stays visible until the first text
      // chunk lands. iOS coalesces our SSE stream into a single
      // waterfall delivery, so without this the user sees a blank
      // screen for several seconds after sending.
      setPendingAgentResponse(true);

      try {
        const { data } = await supabase.auth.getSession();
        const jwt = data.session?.access_token;
        if (!jwt) throw new Error('not signed in');

        const response = await expoFetch(`${API_URL}/chat/turn`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({
            session_id: sessionId,
            user_text: trimmed,
            history: historyTurns,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 402) {
            const body = await response.text().catch(() => '');
            throw new Error(`SPEND_CAP_EXCEEDED ${body}`);
          }
          const body = await response.text().catch(() => '');
          throw new Error(`chat turn failed: ${response.status} ${body.slice(0, 200)}`);
        }

        const body = response.body;
        if (!body) {
          throw new Error('chat response has no body stream');
        }
        // Read the streamed body and append decoded chunks straight to
        // the transcript. The server emits proper SSE frames
        // (`data: <text>\n\n` per chunk + a final `event: done`), but
        // empirically iOS URLSession / expo/fetch strips the SSE
        // framing when Content-Type=text/event-stream — by the time JS
        // sees the body, only the inner data payload reaches us
        // (verified 2026-05-17). Parsing for `data: ` prefixes that
        // don't exist anymore dropped every chunk and produced
        // "talking to myself" empty-response bugs. Trusting the decoded
        // chunks as plain text restores the working pre-SSE behaviour
        // while keeping the server-side SSE chrome (Content-Type +
        // X-Accel-Buffering) that prevents intermediate proxy
        // buffering. If a future RN/iOS update stops stripping framing,
        // the small filter below drops any SSE comment / event lines
        // that leak through so we don't display them.
        const reader = body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const chunk = decoder.decode(value, { stream: true });
          const text = stripStraySseFraming(chunk);
          if (text) {
            // First real text — hide the typing indicator; the streaming
            // bubble takes over from here.
            setPendingAgentResponse(false);
            transcriptRef.current.appendAgentTextChunk(text);
            refreshTranscript();
          }
        }
        const tail = stripStraySseFraming(decoder.decode());
        if (tail) {
          transcriptRef.current.appendAgentTextChunk(tail);
        }
        transcriptRef.current.finalizeAgentTurn();
        refreshTranscript();
      } catch (err) {
        const isAbort =
          err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
        if (isAbort) {
          transcriptRef.current.finalizeAgentTurn();
          refreshTranscript();
          return;
        }
        captureClientError('chat-turn-failed', err, { sessionId });
        setError(err instanceof Error ? err.message : String(err));
        transcriptRef.current.finalizeAgentTurn();
        refreshTranscript();
      } finally {
        // Defensive: clear the indicator on every exit path. The
        // happy path already clears it on first chunk; this catches
        // the cases where the stream completed with zero text, the
        // request errored before any chunk landed, or the user
        // aborted mid-wait.
        setPendingAgentResponse(false);
      }
    },
    [refreshTranscript],
  );

  const end = useCallback(async (): Promise<boolean> => {
    transcriptRef.current.finalizeAgentTurn();
    refreshTranscript();

    const sessionId = sessionIdRef.current;
    const startedAt = startedAtRef.current;
    const finalTranscript = transcriptRef.current.getAll();

    teardown();

    if (!sessionId || !startedAt) return true; // nothing to post

    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data.session?.access_token;
      if (!jwt) throw new Error('not signed in');

      // 10s timeout matches the voice /end pattern — fail fast on dead
      // connections instead of letting RN sit on a stale socket for 60s.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      let r: Response;
      try {
        r = await fetch(`${API_URL}/calls/${sessionId}/end`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`,
          },
          body: JSON.stringify({
            transcript: finalTranscript,
            started_at: startedAt.toISOString(),
            ended_at: new Date().toISOString(),
            end_reason: 'user_ended',
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`end failed: ${r.status} ${body.slice(0, 200)}`);
      }
      return true;
    } catch (err) {
      captureClientError('chat-end-post-failed', err, {
        sessionId,
        turnCount: finalTranscript.length,
      });
      setError(err instanceof Error ? err.message : String(err));
      useChatStore.getState().markDropped();
      return false;
    }
  }, [refreshTranscript, teardown]);

  return {
    start,
    end,
    sendUserText,
    transcript,
    streamingAgentText,
    pendingAgentResponse,
    error,
  };
}
