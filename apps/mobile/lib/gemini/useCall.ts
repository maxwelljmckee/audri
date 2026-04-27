// Top-level call orchestrator. Composes session + audio in/out + transcript
// + the call store. The only file (app)/call.tsx imports.
//
// Lifecycle: start() → POST /calls/start → openSession → start mic → wait for
// model audio → barge-in possible → end() → flush + close + POST /end.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';
import {
  AudioManager,
  PlaybackNotificationManager,
} from 'react-native-audio-api';
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

export interface UseCallResult {
  start: () => Promise<void>;
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

  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshTranscript = useCallback(() => {
    setTranscript(transcriptRef.current.getAll());
  }, []);

  const teardown = useCallback(() => {
    inputRef.current?.stop();
    inputRef.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    outputRef.current?.destroy();
    outputRef.current = null;
    appStateSubRef.current?.remove();
    appStateSubRef.current = null;
    if (Platform.OS === 'android') PlaybackNotificationManager.hide();
    AudioManager.setAudioSessionActivity(false);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const start = useCallback(async () => {
    const gen = ++generationRef.current;
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
        body: JSON.stringify({ agent_slug: 'assistant', call_type: 'generic' }),
      });
      if (!r.ok) throw new Error(`start failed: ${r.status} ${await r.text()}`);
      const { sessionId, ephemeralToken, model } = (await r.json()) as StartCallResponse;
      sessionIdRef.current = sessionId;
      startedAtRef.current = new Date();

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

      // While model is playing, gate mic-send to prevent echo loop.
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

      input.onAmplitude((amp) => {
        // Show user amplitude only when not gated (i.e. user actually transmitting).
        if (!output.isPlaying()) {
          store.setAmplitude(amp);
          if (amp > 0.05) store.setSpeaker('user');
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

      // 6. Resume audio context if backgrounded.
      appStateSubRef.current = AppState.addEventListener('change', (state: AppStateStatus) => {
        if (state === 'active' && outputRef.current) {
          // No-op for now; AudioContext may need explicit resume in some cases.
        }
      });

      if (Platform.OS === 'android') {
        PlaybackNotificationManager.show({ title: 'Audri', artist: 'Voice call active' });
      }

      // 7. Kick the model off with a greeting prompt.
      session.sendText('Greet me now.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      teardown();
      useCallStore.getState().markDropped();
    }
  }, [refreshTranscript, teardown]);

  const end = useCallback(async () => {
    generationRef.current++; // invalidate any in-flight start
    transcriptRef.current.finalizeAgentTurn();
    refreshTranscript();

    const sessionId = sessionIdRef.current;
    const startedAt = startedAtRef.current;
    const finalTranscript = transcriptRef.current.getAll();

    teardown();

    if (!sessionId || !startedAt) return;

    try {
      const { data } = await supabase.auth.getSession();
      const jwt = data.session?.access_token;
      if (!jwt) return;

      await fetch(`${API_URL}/calls/${sessionId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          transcript: finalTranscript,
          started_at: startedAt.toISOString(),
          ended_at: new Date().toISOString(),
          end_reason: 'user_ended',
        }),
      });
    } catch (e) {
      // Logged client-side only; the server preserved the transcript at /start.
      console.warn('[useCall] /end post failed', e);
    }
  }, [refreshTranscript, teardown]);

  return { start, end, transcript, error };
}
