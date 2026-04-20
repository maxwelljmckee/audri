import {
  EndSensitivity,
  GoogleGenAI,
  Modality,
  StartSensitivity,
} from "@google/genai";
import {
  AudioContext,
  AudioManager,
  AudioRecorder,
  GainNode,
  OscillatorNode,
  PlaybackNotificationManager,
} from "react-native-audio-api";
import { useCallback, useRef, useState } from "react";
import { AppState, AppStateStatus, Platform } from "react-native";
import {
  base64ToInt16Array,
  float32ToPcm16,
  pcm16ToBase64,
} from "../utils/audio";

const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY!;
const MODEL = "gemini-3.1-flash-live-preview";
const MIC_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

export function useGeminiLive() {
  const [isConnected, setIsConnected] = useState(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);

  const sessionRef = useRef<Awaited<ReturnType<typeof ai.live.connect>> | null>(
    null,
  );
  const recorder = useRef<AudioRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const queueSourceRef = useRef<ReturnType<
    AudioContext["createBufferQueueSource"]
  > | null>(null);
  const chunksSent = useRef(0);
  const chunksDroppedDuringPlayback = useRef(0);
  const connectGenRef = useRef(0);
  const isModelSpeakingRef = useRef(false);
  const turnEndingRef = useRef(false);
  const pendingBuffersRef = useRef(0);
  const keepAliveOscRef = useRef<OscillatorNode | null>(null);
  const keepAliveGainRef = useRef<GainNode | null>(null);
  const appStateSubRef = useRef<ReturnType<
    typeof AppState.addEventListener
  > | null>(null);

  const getAudioCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new AudioContext({
        sampleRate: PLAYBACK_SAMPLE_RATE,
      });
    }
    return audioCtxRef.current;
  }, []);

  const startKeepAlive = useCallback(() => {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    keepAliveOscRef.current = osc;
    keepAliveGainRef.current = gain;
  }, [getAudioCtx]);

  const stopKeepAlive = useCallback(() => {
    if (keepAliveOscRef.current) {
      try {
        keepAliveOscRef.current.stop();
      } catch {}
      keepAliveOscRef.current = null;
    }
    keepAliveGainRef.current = null;
  }, []);

  const finalizeTurn = useCallback(() => {
    if (!turnEndingRef.current) return;
    if (pendingBuffersRef.current > 0) return;
    if (queueSourceRef.current) {
      try {
        queueSourceRef.current.stop();
      } catch {}
      queueSourceRef.current = null;
    }
    turnEndingRef.current = false;
    isModelSpeakingRef.current = false;
    setIsModelSpeaking(false);
  }, []);

  const stopCurrentPlayback = useCallback(() => {
    if (queueSourceRef.current) {
      try {
        queueSourceRef.current.clearBuffers();
        queueSourceRef.current.stop();
      } catch {}
      queueSourceRef.current = null;
    }
    pendingBuffersRef.current = 0;
    turnEndingRef.current = false;
    isModelSpeakingRef.current = false;
    setIsModelSpeaking(false);
  }, []);

  const enqueueChunk = useCallback(
    (chunk: Int16Array) => {
      const ctx = getAudioCtx();

      const float32 = new Float32Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        float32[i] = chunk[i] / 32768;
      }
      const buffer = ctx.createBuffer(1, chunk.length, PLAYBACK_SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);

      if (!queueSourceRef.current) {
        console.log("[Playback] New queue source (turn start)");
        const src = ctx.createBufferQueueSource();
        src.connect(ctx.destination);
        // onEnded fires per-buffer, not per-source. Track the pending count
        // so isModelSpeakingRef stays true across the whole turn — if we
        // flipped it per buffer, the mic gate would open during playback
        // gaps and Gemini would hear its own echo and start a new turn.
        src.onEnded = () => {
          if (queueSourceRef.current !== src) return;
          pendingBuffersRef.current = Math.max(
            0,
            pendingBuffersRef.current - 1,
          );
          finalizeTurn();
        };
        src.start();
        queueSourceRef.current = src;
        isModelSpeakingRef.current = true;
        setIsModelSpeaking(true);
      }

      queueSourceRef.current.enqueueBuffer(buffer);
      pendingBuffersRef.current++;
    },
    [getAudioCtx, finalizeTurn],
  );

  const startMic = useCallback(async () => {
    const permission = await AudioManager.requestRecordingPermissions();
    console.log("[Mic] Permission:", permission);
    if (permission !== "Granted") {
      console.error("[Mic] Permission denied");
      return;
    }
    console.log("[Mic] Starting");
    const rec = new AudioRecorder();
    recorder.current = rec;

    rec.onError((err) => console.error("[Mic] Error:", JSON.stringify(err)));

    const readyResult = rec.onAudioReady(
      { sampleRate: MIC_SAMPLE_RATE, bufferLength: 1600, channelCount: 1 },
      ({ buffer, numFrames }) => {
        chunksSent.current++;
        if (chunksSent.current === 1) console.log("[Mic] First chunk received");
        if (chunksSent.current % 50 === 0) {
          console.log(
            `[Mic] ${chunksSent.current} chunks sent (${numFrames} frames)`,
          );
        }
        if (!sessionRef.current) {
          console.warn("[Mic] sessionRef null — chunk dropped");
          return;
        }
        // Gate the mic while the model is speaking to prevent the speaker→mic
        // feedback loop from re-triggering server-side VAD.
        if (isModelSpeakingRef.current) {
          chunksDroppedDuringPlayback.current++;
          if (chunksDroppedDuringPlayback.current % 50 === 0) {
            console.log(
              `[Mic] ${chunksDroppedDuringPlayback.current} chunks gated during playback`,
            );
          }
          return;
        }
        const float32 = buffer.getChannelData(0);
        const pcm16 = float32ToPcm16(float32);
        const base64 = pcm16ToBase64(pcm16);
        sessionRef.current.sendRealtimeInput({
          audio: {
            data: base64,
            mimeType: `audio/pcm;rate=${MIC_SAMPLE_RATE}`,
          },
        });
      },
    );
    console.log("[Mic] onAudioReady result:", JSON.stringify(readyResult));

    const startResult = rec.start();
    console.log("[Mic] start() result:", JSON.stringify(startResult));
  }, []);

  const connect = useCallback(async () => {
    const gen = ++connectGenRef.current;
    console.log("[Gemini] Connecting…");
    AudioManager.setAudioSessionOptions({
      iosCategory: "playAndRecord",
      iosMode: "voiceChat",
      iosOptions: ["defaultToSpeaker", "allowBluetoothHFP"],
    });
    await AudioManager.setAudioSessionActivity(true);
    chunksSent.current = 0;

    const session = await ai.live.connect({
      model: MODEL,
      config: {
        systemInstruction: `You are Muse, a voice-first AI assistant built into a personal knowledge app. You help the user with three core things:

1. Notes & research — capture ideas, look things up, summarize sources, and store anything worth keeping.
2. Thought partnership — help the user think through problems, connect ideas across different domains, and surface patterns they might be missing.
3. Daily rhythm — produce a morning brief of what's ahead (meetings, tasks, goals) or an evening summary of what got done and what's carrying forward.

Personality: calm, direct, and a little warm — like a smart friend who happens to know a lot. Never over-enthusiastic, never robotic. No filler phrases like "Certainly!" or "Great question!". If you don't know something, say so plainly.

When the session starts, immediately open with a short greeting — one sentence, no fanfare, don't wait for the user to speak first. The user's name is Max. Use it sometimes, skip it other times — vary it naturally so it doesn't feel like a pattern. Something like "Hey Max, what's on your mind?" or "Hey — what are we working on?" or "What's up?" Keep it unpredictable.`,
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            prefixPaddingMs: 300,
            silenceDurationMs: 1500,
          },
        },
      },
      callbacks: {
        onopen: () => console.log("[Gemini] Session open"),
        onmessage: (message) => {
          if (message.data) {
            enqueueChunk(base64ToInt16Array(message.data));
          }
          if (message.serverContent?.interrupted) {
            console.log("[Gemini] Interrupted");
            stopCurrentPlayback();
          }
          if (message.serverContent?.turnComplete) {
            console.log("[Gemini] Turn complete — draining playback");
            // Don't stop the source here — let buffered audio play out.
            // finalizeTurn will tear down once pendingBuffers reaches 0.
            turnEndingRef.current = true;
            finalizeTurn();
          }
        },
        onerror: (e) => console.error("[Gemini] Error:", e),
        onclose: (e) => {
          console.log("[Gemini] Closed:", e.reason);
          setIsConnected(false);
          setIsModelSpeaking(false);
        },
      },
    });

    if (gen !== connectGenRef.current) {
      console.log("[Gemini] Stale connect — closing");
      session.close();
      return;
    }

    sessionRef.current = session;
    setIsConnected(true);

    session.sendRealtimeInput({ text: "Greet me now." });

    startMic();
    startKeepAlive();

    // Resume audio context if it gets suspended when the screen turns off.
    appStateSubRef.current = AppState.addEventListener(
      "change",
      (state: AppStateStatus) => {
        if (
          (state === "background" || state === "inactive") &&
          audioCtxRef.current
        ) {
          audioCtxRef.current.resume();
        }
      },
    );

    if (Platform.OS === "android") {
      PlaybackNotificationManager.show({
        title: "Constellate",
        artist: "Voice call active",
      });
    }
  }, [
    startMic,
    stopCurrentPlayback,
    enqueueChunk,
    finalizeTurn,
    startKeepAlive,
  ]);

  const disconnect = useCallback(() => {
    console.log("[Gemini] Disconnecting");
    connectGenRef.current++; // invalidate any in-flight connect
    recorder.current?.stop();
    recorder.current = null;
    sessionRef.current?.close();
    sessionRef.current = null;
    stopCurrentPlayback();
    stopKeepAlive();
    appStateSubRef.current?.remove();
    appStateSubRef.current = null;
    if (Platform.OS === "android") {
      PlaybackNotificationManager.hide();
    }
    // Close the AudioContext to release the audio engine, then deactivate the
    // session. Deactivating the session is what clears the Dynamic Island mic
    // indicator on iOS — stopping the recorder alone is not sufficient.
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    AudioManager.setAudioSessionActivity(false);
    setIsConnected(false);
  }, [stopCurrentPlayback, stopKeepAlive]);

  return { connect, disconnect, isConnected, isModelSpeaking };
}
