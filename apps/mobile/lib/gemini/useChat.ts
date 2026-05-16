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
        const reader = body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            if (chunk) {
              transcriptRef.current.appendAgentTextChunk(chunk);
              refreshTranscript();
            }
          }
        }
        const tail = decoder.decode();
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

  return { start, end, sendUserText, transcript, streamingAgentText, error };
}
