// Top-level call orchestrator. Composes session + audio in/out + transcript
// + the call store. The only file (app)/call.tsx imports.
//
// Lifecycle: start() → POST /calls/start → openSession → start mic → wait for
// model audio → barge-in possible → end() → flush + close + POST /end.
//
// Modality: 'voice' (default) wires audio in/out + barge-in; 'text' skips
// audio entirely and exposes sendUserText for the chat UI to drive turns.
//
// Incognito: skips snapshot persistence + the /end POST. Same agent
// experience; zero server-side residue beyond the initial token mint.

import { fetch as expoFetch } from 'expo/fetch';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { AudioManager } from 'react-native-audio-api';
import { type CallSnapshot, clearCallSnapshot, saveCallSnapshot } from '../callRecovery';
import { captureClientError } from '../sentry';
import { supabase } from '../supabase';
import { type CallModality, useCallStore } from '../useCallStore';
import { type AudioInputHandle, createAudioInput } from './audio-input';
import { type AudioOutputHandle, createAudioOutput } from './audio-output';
import { type SessionHandle, openSession } from './session';
import { createToolCallLog } from './tool-log';
import { handleToolCalls } from './tool-runtime';
import { type TranscriptTurn, createTranscript } from './transcript';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

interface StartCallResponse {
  sessionId: string;
  // null for text mode — no Gemini WebSocket on the client side.
  ephemeralToken: string | null;
  model: string;
  voice: string;
  expiresAt: string | null;
}

export type CallType = 'generic' | 'onboarding';

export interface StartCallOpts {
  callType?: CallType;
  modality?: CallModality;
  incognito?: boolean;
}

export interface UseCallResult {
  start: (opts?: StartCallOpts) => Promise<void>;
  // Returns true if /calls/:id/end posted successfully (or there was nothing
  // to post). False means the post failed; the call has been marked dropped
  // and the caller should NOT auto-route home — let the user see the error
  // and decide. Snapshot stays on disk for the launch sweep on next start.
  end: () => Promise<boolean>;
  // Text-mode only: append a user turn locally + push it to the live session.
  // Voice mode user turns are populated server-side via inputAudioTranscription.
  sendUserText: (text: string) => void;
  transcript: TranscriptTurn[];
  // In-progress agent turn (text mode). Renders as the live streaming bubble
  // beneath finalized turns. Always '' in voice mode.
  streamingAgentText: string;
  error: string | null;
}

export function useCall(): UseCallResult {
  const sessionRef = useRef<SessionHandle | null>(null);
  const inputRef = useRef<AudioInputHandle | null>(null);
  const outputRef = useRef<AudioOutputHandle | null>(null);
  const transcriptRef = useRef(createTranscript());
  const toolLogRef = useRef(createToolCallLog());
  const sessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<Date | null>(null);
  const appStateSubRef = useRef<ReturnType<typeof AppState.addEventListener> | null>(null);
  const generationRef = useRef(0);

  const callTypeRef = useRef<CallType>('generic');
  const modalityRef = useRef<CallModality>('voice');
  const incognitoRef = useRef<boolean>(false);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [streamingAgentText, setStreamingAgentText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Persist a snapshot of the active call so a force-quit / network drop /
  // background suspend can be recovered on next launch (or right now via
  // the AppState 'background' handler below). Only voice non-incognito
  // sessions snapshot:
  //   - Incognito: recovery would re-attach a call we've promised not to keep.
  //   - Text mode: no background-audio entitlement to keep the WebSocket
  //     alive, so force-quit recovery isn't meaningful; lean on /end at the
  //     user's explicit "End Chat" instead.
  const persistSnapshot = useCallback(() => {
    if (incognitoRef.current) return;
    if (modalityRef.current === 'text') return;
    const sessionId = sessionIdRef.current;
    const startedAt = startedAtRef.current;
    if (!sessionId || !startedAt) return;
    const snapshot: CallSnapshot = {
      sessionId,
      startedAt: startedAt.toISOString(),
      lastTouched: new Date().toISOString(),
      transcript: transcriptRef.current.getAll(),
      callType: callTypeRef.current,
    };
    void saveCallSnapshot(snapshot);
  }, []);

  const refreshTranscript = useCallback(() => {
    setTranscript(transcriptRef.current.getAll());
    // Streaming bubble only matters in text mode; skip the setState in
    // voice mode to avoid an unnecessary render per chunk.
    if (modalityRef.current === 'text') {
      setStreamingAgentText(transcriptRef.current.getStreamingAgentText());
    }
    persistSnapshot();
  }, [persistSnapshot]);

  const teardown = useCallback(() => {
    inputRef.current?.stop();
    inputRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    outputRef.current?.destroy();
    outputRef.current = null;
    appStateSubRef.current?.remove();
    appStateSubRef.current = null;
    // Only deactivate the iOS audio session for voice modality — text-mode
    // never activated it, so the call here would be a no-op at best and
    // could clobber an unrelated audio session at worst.
    if (modalityRef.current === 'voice') {
      AudioManager.setAudioSessionActivity(false);
    }
  }, []);

  // Single drop path used by every non-user-ended exit (session onError,
  // WebSocket onClose, mic onError, start() failure). Always tears down
  // audio first — the iOS Dynamic Island mic indicator stays lit until
  // the audio session is deactivated, so skipping teardown on these paths
  // leaves the device with a "still recording" signal even though the
  // call is over. Store transition is gated on status: 'ending' means
  // end() is already driving the shutdown, don't clobber its state.
  const dropCall = useCallback(
    (errorMessage?: string) => {
      teardown();
      const status = useCallStore.getState().status;
      if (status === 'connecting' || status === 'connected') {
        useCallStore.getState().markDropped();
      }
      if (errorMessage) setError(errorMessage);
    },
    [teardown],
  );

  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(
    async (opts?: StartCallOpts) => {
      const gen = ++generationRef.current;
      const callType: CallType = opts?.callType ?? 'generic';
      const modality: CallModality = opts?.modality ?? 'voice';
      const incognito = opts?.incognito ?? false;
      callTypeRef.current = callType;
      modalityRef.current = modality;
      incognitoRef.current = incognito;
      // Mirror to store so screens / FAB can read without prop-drilling
      // through CallContext.
      useCallStore.getState().setModality(modality);
      useCallStore.getState().setIncognito(incognito);
      setError(null);
      transcriptRef.current.reset();
      toolLogRef.current.reset();
      setTranscript([]);

      const store = useCallStore.getState();

      try {
        // 1. Get JWT + ephemeral token
        const { data: sessionData } = await supabase.auth.getSession();
        const jwt = sessionData.session?.access_token;
        if (!jwt) throw new Error('not signed in');

        const r = await fetch(`${API_URL}/calls/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({
            agent_slug: 'assistant',
            call_type: callType,
            modality: modality === 'text' ? 'text' : 'audio',
            incognito,
          }),
        });
        if (!r.ok) {
          // 402 Payment Required = hard spending-cap. Use a distinct
          // error message the call screen can detect (substring match)
          // and route to a "monthly limit reached" state with a
          // deep-link to the SetLimit modal.
          const bodyText = await r.text().catch(() => '');
          if (r.status === 402) {
            throw new Error(`SPEND_CAP_EXCEEDED ${bodyText}`);
          }
          throw new Error(`start failed: ${r.status} ${bodyText}`);
        }
        const { sessionId, ephemeralToken, model } = (await r.json()) as StartCallResponse;
        sessionIdRef.current = sessionId;
        const startedAt = new Date();
        startedAtRef.current = startedAt;
        // Mirror to store so the call screen can compute elapsed time
        // across mount/unmount cycles (back button → home → rejoin).
        useCallStore.getState().setStartedAt(startedAt.getTime());
        // Initial snapshot: now if the app dies before we ever get a transcript
        // turn, we still have something to recover with.
        persistSnapshot();

        if (gen !== generationRef.current) return; // stale

        // Text mode: no Gemini WebSocket. sendUserText posts to
        // /chat/turn per message and streams chunks back. Mark connected
        // so the chat screen flips out of "Connecting…" and accepts input.
        if (modality === 'text') {
          useCallStore.getState().markConnected();
          return;
        }

        // 2. Audio init — voice modality only. Text mode skips iOS audio
        //    session config + mic/output + amplitude / barge-in.
        if (modality === 'voice') {
          AudioManager.setAudioSessionOptions({
            iosCategory: 'playAndRecord',
            iosMode: 'voiceChat',
            iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP'],
          });
          await AudioManager.setAudioSessionActivity(true);

          const output = createAudioOutput();
          outputRef.current = output;
          const input = createAudioInput();
          inputRef.current = input;

          // Mic-gate during playback prevents Gemini hearing Audri through the
          // speakerphone. Barge-in via fixed amp threshold + sustained window.
          output.onPlaybackStart(() => {
            input.setGated(true);
            store.setSpeaker('agent');
          });
          output.onPlaybackEnd(() => {
            input.setGated(false);
            transcriptRef.current.finalizeAgentTurn();
            refreshTranscript();
            store.setSpeaker(null);
          });

          // Peak-amplitude threshold. Typical voice peaks 0.3-0.5; echo after AEC
          // typically stays below 0.1. 0.15 gives a comfortable margin.
          // Tuned against measured peak amplitudes: voice peaks 0.06-0.27, echo
          // after AEC stays under ~0.05. Re-tune from telemetry once observability
          // service lands.
          const BARGE_IN_THRESHOLD = 0.06;
          const BARGE_IN_SUSTAINED_MS = 100;
          let loudSinceMs: number | null = null;

          input.onAmplitude((amp) => {
            store.setAmplitude(amp);

            if (output.isPlaying()) {
              if (amp > BARGE_IN_THRESHOLD) {
                if (loudSinceMs === null) {
                  loudSinceMs = Date.now();
                } else if (Date.now() - loudSinceMs >= BARGE_IN_SUSTAINED_MS) {
                  loudSinceMs = null;
                  output.flush();
                  input.setGated(false);
                  transcriptRef.current.finalizeAgentTurn();
                  refreshTranscript();
                  store.setSpeaker('user');
                }
              } else {
                loudSinceMs = null;
              }
            } else if (amp > 0.05) {
              store.setSpeaker('user');
            }
          });

          input.onError((e) => dropCall(e.message));
        }

        // 3. Open Gemini Live session. Voice modality only now —
        //    text mode early-returned above.
        if (!ephemeralToken) {
          throw new Error('audio session missing ephemeral token');
        }
        const output = outputRef.current;
        const input = inputRef.current;
        const session = await openSession(
          { ephemeralToken, model },
          {
            onOpen: () => store.markConnected(),
            onModelAudio: (b64) => output?.enqueue(b64),
            onModelTextChunk: (chunk) => {
              transcriptRef.current.appendAgentTextChunk(chunk);
            },
            onUserText: (text) => {
              transcriptRef.current.appendUserText(text);
              refreshTranscript();
            },
            onTurnComplete: () => {
              // Don't tear down playback — wait for the queue to drain
              // via per-buffer onEnded.
              output?.markTurnComplete();
            },
            onInterrupted: () => {
              output?.flush();
              transcriptRef.current.finalizeAgentTurn();
              refreshTranscript();
            },
            onError: (err) => dropCall(err.message),
            onClose: (reason) => {
              // Server closed unexpectedly. dropCall tears down audio
              // unconditionally; the store transition is gated on status
              // so we don't clobber a clean 'ending' shutdown driven by
              // end(). 'idle' / 'dropped' cases are no-ops.
              const status = useCallStore.getState().status;
              if (status === 'connecting' || status === 'connected') {
                dropCall(`connection closed: ${reason}`);
              } else {
                // Already on a shutdown path — just make sure audio is
                // released so the mic indicator clears even if the close
                // raced past end()'s teardown.
                teardown();
              }
            },
            onToolCall: (calls) => {
              // Don't block the message handler — fulfill async and reply
              // when ready. handleToolCalls catches its own errors and
              // ensures every call gets a response (success or error
              // payload) so Gemini Live isn't left waiting.
              toolLogRef.current.recordCustomCalls(calls);
              void handleToolCalls(calls, (responses) => {
                toolLogRef.current.recordCustomResponses(responses);
                if (sessionRef.current?.isOpen()) {
                  sessionRef.current.sendToolResponse(responses);
                }
              });
            },
            onGroundingMetadata: (metadata) => {
              toolLogRef.current.recordGrounding(metadata);
            },
            onUsageMetadata: (usage) => {
              toolLogRef.current.recordSessionUsage(usage);
            },
          },
        );
        sessionRef.current = session;

        if (gen !== generationRef.current) {
          session.close();
          return;
        }

        // 4. Wire mic → session.
        if (!input) throw new Error('audio input missing for voice session');
        input.onFrame((b64) => session.sendAudio(b64));
        await input.start();

        // 5. Backgrounded calls KEEP RUNNING — Audri behaves like a regular
        // phone call. iOS keeps our audio session + WebSocket alive via the
        // `UIBackgroundModes: ["audio"]` entitlement in app.json. Only the
        // user's explicit End-Call button (or a hard failure: force-quit,
        // crash, network drop) terminates the session.
        //
        // The snapshot keeps getting refreshed via persistSnapshot() on every
        // transcript change, so a hard failure mid-call still recovers via
        // the launch sweep. Backgrounding alone doesn't trigger anything.
        appStateSubRef.current = AppState.addEventListener('change', () => {
          // Intentional no-op. Background-audio entitlement does the work.
        });

        // 6. Kick the model off. The cue routes through the system prompt — for
        // onboarding it triggers the structured self-intro + opener; for generic
        // it's just a casual greeting.
        session.sendText(
          callType === 'onboarding'
            ? "Begin the onboarding call now. Open with your self-introduction, then ask the life-history opener as described in your scaffolding. Don't ask 'what brings you here' or 'what can I help you with' — those are explicitly out of scope for the opener."
            : 'Greet me now.',
        );
      } catch (e) {
        // Surface to Sentry — silent setError-only handling meant connection
        // failures were invisible. The dropped-call screen still shows the
        // user the error message via `error` state; this just adds a server-
        // side trail.
        captureClientError('call-start-failed', e, {
          sessionId: sessionIdRef.current,
        });
        dropCall(e instanceof Error ? e.message : String(e));
      }
    },
    [persistSnapshot, refreshTranscript, dropCall, teardown],
  );

  const end = useCallback(async (): Promise<boolean> => {
    generationRef.current++; // invalidate any in-flight start
    transcriptRef.current.finalizeAgentTurn();
    refreshTranscript();

    const sessionId = sessionIdRef.current;
    const startedAt = startedAtRef.current;
    const finalTranscript = transcriptRef.current.getAll();
    const incognito = incognitoRef.current;

    teardown();

    // Incognito: nothing was ever persisted server-side (no /start row, no
    // snapshot). Skip the /end POST entirely and treat as a clean close.
    if (incognito) {
      void clearCallSnapshot();
      return true;
    }

    if (!sessionId || !startedAt) {
      void clearCallSnapshot();
      return true; // nothing to post → treat as ok
    }

    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data.session?.access_token;
      if (!jwt) throw new Error('not signed in');

      // 10s timeout on the post. Without this, RN's fetch will sit on a
      // dead connection (e.g. WebSocket killed during screen lock) for
      // 60s+ before iOS gives up — that's the "thread-locking task" feel
      // we hit on 2026-05-01. Fail fast, surface to the user, fall back to
      // the launch sweep on next app start.
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
            tool_calls: toolLogRef.current.snapshot(),
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

      // Only clear the snapshot once the server has accepted the close.
      // If /end failed, the snapshot stays on disk so the launch sweep can
      // retry next time.
      await clearCallSnapshot();
      return true;
    } catch (err) {
      // Surface to Sentry + the user. Silent failures here meant orphan
      // call_transcripts rows + lost transcripts (see incident 2026-05-01).
      // Snapshot stays on disk for the launch sweep on next app start.
      captureClientError('call-end-post-failed', err, {
        sessionId,
        turnCount: finalTranscript.length,
      });
      setError(err instanceof Error ? err.message : String(err));
      useCallStore.getState().markDropped();
      return false;
    }
  }, [refreshTranscript, teardown]);

  // Text-mode user input. Posts to /chat/turn with the full history +
  // user text; reads the streamed agent response back as chunks via
  // expo/fetch (RN's stock fetch buffers entire response bodies — only
  // expo/fetch exposes a streaming ReadableStream).
  //
  // Tools (search_wiki / fetch_page / search_transcripts / fetch_transcript
  // / googleSearch) run server-side and are invisible to the client. The
  // stream only carries the final agent text.
  const sendUserText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;

      transcriptRef.current.appendUserText(trimmed);
      refreshTranscript();

      // History = everything currently finalized in the transcript,
      // EXCLUDING the user turn we just appended (it goes on the wire as
      // `user_text`). The model's contents array gets rebuilt server-side
      // each turn — no need to ship tool-call exchanges.
      const turns = transcriptRef.current.getAll();
      const historyTurns = turns.slice(0, -1).map((t) => ({ role: t.role, text: t.text }));

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
        });

        if (!response.ok) {
          // Spend-cap = 402. Match the voice-call error surfacing so the
          // chat screen can render the same "limit reached" affordance.
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
        captureClientError('chat-turn-failed', err, { sessionId });
        setError(err instanceof Error ? err.message : String(err));
        // Don't tear down the whole session on a single turn failure —
        // user can retry by sending another message. Finalize whatever
        // partial agent text we've accumulated so the bubble isn't left
        // mid-stream.
        transcriptRef.current.finalizeAgentTurn();
        refreshTranscript();
      }
    },
    [refreshTranscript],
  );

  return { start, end, sendUserText, transcript, streamingAgentText, error };
}
