// Top-level call orchestrator. Composes session + audio in/out + transcript
// + the call store. The only file (app)/call.tsx imports.
//
// Lifecycle: start() → POST /calls/start → openSession → start mic → wait for
// model audio → barge-in possible → end() → flush + close + POST /end.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { AudioManager } from 'react-native-audio-api';
import {
  type CallSnapshot,
  clearCallSnapshot,
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
  // Returns true if /calls/:id/end posted successfully (or there was nothing
  // to post). False means the post failed; the call has been marked dropped
  // and the caller should NOT auto-route home — let the user see the error
  // and decide. Snapshot stays on disk for the launch sweep on next start.
  end: () => Promise<boolean>;
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

      // 6. Backgrounded calls KEEP RUNNING — Audri behaves like a regular
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

      // 7. Kick the model off. The cue routes through the system prompt — for
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
      setError(e instanceof Error ? e.message : String(e));
      teardown();
      useCallStore.getState().markDropped();
    }
  }, [persistSnapshot, refreshTranscript, teardown]);

  const end = useCallback(async (): Promise<boolean> => {
    generationRef.current++; // invalidate any in-flight start
    transcriptRef.current.finalizeAgentTurn();
    refreshTranscript();

    const sessionId = sessionIdRef.current;
    const startedAt = startedAtRef.current;
    const finalTranscript = transcriptRef.current.getAll();

    teardown();

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

  return { start, end, transcript, error };
}
