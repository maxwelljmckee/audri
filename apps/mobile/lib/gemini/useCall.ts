// Top-level call orchestrator. Composes session + audio in/out + transcript
// + the call store. The only file (app)/call.tsx imports.
//
// Lifecycle: start() → POST /calls/start → openSession → start mic → wait for
// model audio → barge-in possible → end() → flush + close + POST /end.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { AudioManager } from 'react-native-audio-api';
import {
  type CallSnapshot,
  clearCallSnapshot,
  recoverCall,
  saveCallSnapshot,
} from '../callRecovery';
import { captureClientError } from '../sentry';
import { supabase } from '../supabase';
import { useCallStore } from '../useCallStore';
import { type AudioInputHandle, createAudioInput } from './audio-input';
import { type AudioOutputHandle, createAudioOutput } from './audio-output';
import { type SessionHandle, openSession } from './session';
import { type TranscriptTurn, createTranscript } from './transcript';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

interface StartCallResponse {
  sessionId: string;
  ephemeralToken: string;
  model: string;
  voice: string;
  expiresAt: string;
}

export type CallType = 'generic' | 'onboarding';

export interface UseCallResult {
  start: (opts?: { callType?: CallType }) => Promise<void>;
  end: () => Promise<void>;
  transcript: TranscriptTurn[];
  error: string | null;
}

export function useCall(): UseCallResult {
  const sessionRef = useRef<SessionHandle | null>(null);
  const inputRef = useRef<AudioInputHandle | null>(null);
  const outputRef = useRef<AudioOutputHandle | null>(null);
  const transcriptRef = useRef(createTranscript());
  const sessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<Date | null>(null);
  const appStateSubRef = useRef<ReturnType<typeof AppState.addEventListener> | null>(null);
  const generationRef = useRef(0);

  const callTypeRef = useRef<CallType>('generic');
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Persist a snapshot of the active call so a force-quit / network drop /
  // background suspend can be recovered on next launch (or right now via
  // the AppState 'background' handler below).
  const persistSnapshot = useCallback(() => {
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
    AudioManager.setAudioSessionActivity(false);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(async (opts?: { callType?: CallType }) => {
    const gen = ++generationRef.current;
    const callType: CallType = opts?.callType ?? 'generic';
    callTypeRef.current = callType;
    setError(null);
    transcriptRef.current.reset();
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
        body: JSON.stringify({ agent_slug: 'assistant', call_type: callType }),
      });
      if (!r.ok) throw new Error(`start failed: ${r.status} ${await r.text()}`);
      const { sessionId, ephemeralToken, model } = (await r.json()) as StartCallResponse;
      sessionIdRef.current = sessionId;
      startedAtRef.current = new Date();
      // Initial snapshot: now if the app dies before we ever get a transcript
      // turn, we still have something to recover with.
      persistSnapshot();

      if (gen !== generationRef.current) return; // stale

      // 2. Configure iOS audio session for voice chat
      AudioManager.setAudioSessionOptions({
        iosCategory: 'playAndRecord',
        iosMode: 'voiceChat',
        iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP'],
      });
      await AudioManager.setAudioSessionActivity(true);

      // 3. Build audio in/out
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

      input.onError((e) => setError(e.message));

      // 4. Open Gemini Live session
      const session = await openSession(
        { ephemeralToken, model },
        {
          onOpen: () => store.markConnected(),
          onModelAudio: (b64) => output.enqueue(b64),
          onModelTextChunk: (chunk) => {
            transcriptRef.current.appendAgentTextChunk(chunk);
          },
          onUserText: (text) => {
            transcriptRef.current.appendUserText(text);
            refreshTranscript();
          },
          onTurnComplete: () => {
            // Don't tear down playback — wait for the queue to drain via per-buffer onEnded.
            output.markTurnComplete();
          },
          onInterrupted: () => {
            output.flush();
            transcriptRef.current.finalizeAgentTurn();
            refreshTranscript();
          },
          onError: (err) => setError(err.message),
          onClose: (reason) => {
            // Server closed unexpectedly while we were active → mark dropped.
            if (useCallStore.getState().status === 'connected') {
              useCallStore.getState().markDropped();
              setError(`connection closed: ${reason}`);
            }
          },
        },
      );
      sessionRef.current = session;

      if (gen !== generationRef.current) {
        session.close();
        return;
      }

      // 5. Wire mic → session
      input.onFrame((b64) => session.sendAudio(b64));
      await input.start();

      // 6. AppState handler. When iOS suspends us the WebSocket is going to
      // die anyway — get ahead of it: tear down cleanly and POST /end with
      // end_reason='app_backgrounded' so the transcript is preserved and
      // ingestion can run.
      appStateSubRef.current = AppState.addEventListener(
        'change',
        (state: AppStateStatus) => {
          if (state !== 'background' && state !== 'inactive') return;
          if (useCallStore.getState().status !== 'connected') return;
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
          generationRef.current++; // invalidate any in-flight start
          teardown();
          useCallStore.getState().reset();
          void recoverCall(snapshot, 'app_backgrounded')
            .then(() => clearCallSnapshot())
            .catch((err) => {
              captureClientError('call-background-recovery', err, {
                sessionId: snapshot.sessionId,
                turnCount: snapshot.transcript.length,
              });
              // Snapshot stays on disk — the launch sweep will retry.
            });
        },
      );

      // 7. Kick the model off. The cue routes through the system prompt — for
      // onboarding it triggers the structured self-intro + opener; for generic
      // it's just a casual greeting.
      session.sendText(
        callType === 'onboarding'
          ? "Begin the onboarding call now. Open with your self-introduction, then ask the life-history opener as described in your scaffolding. Don't ask 'what brings you here' or 'what can I help you with' — those are explicitly out of scope for the opener."
          : 'Greet me now.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      teardown();
      useCallStore.getState().markDropped();
    }
  }, [persistSnapshot, refreshTranscript, teardown]);

  const end = useCallback(async () => {
    generationRef.current++; // invalidate any in-flight start
    transcriptRef.current.finalizeAgentTurn();
    refreshTranscript();

    const sessionId = sessionIdRef.current;
    const startedAt = startedAtRef.current;
    const finalTranscript = transcriptRef.current.getAll();

    teardown();

    if (!sessionId || !startedAt) {
      void clearCallSnapshot();
      return;
    }

    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data.session?.access_token;
      if (!jwt) return;

      const r = await fetch(`${API_URL}/calls/${sessionId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          transcript: finalTranscript,
          started_at: startedAt.toISOString(),
          ended_at: new Date().toISOString(),
          end_reason: 'user_ended',
        }),
      });
      // Only clear the snapshot once the server has accepted the close.
      // If /end failed, the snapshot stays on disk so the launch sweep can
      // retry next time.
      if (r.ok) {
        await clearCallSnapshot();
      }
    } catch {
      // Server preserved the transcript at /start; failure here is non-fatal.
      // Snapshot stays on disk for the launch sweep to retry.
    }
  }, [refreshTranscript, teardown]);

  return { start, end, transcript, error };
}
