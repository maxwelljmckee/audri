// Thin typed wrapper around @google/genai's ai.live.connect.
// Knows nothing about audio buffers, transcripts, or the call store.

import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai';

export interface SessionConfig {
  ephemeralToken: string;
  model: string;
}

export interface SessionCallbacks {
  onOpen?: () => void;
  // Model audio frame, base64 PCM16 24kHz.
  onModelAudio?: (base64Pcm: string) => void;
  // Streaming model-text chunks (from outputAudioTranscription).
  onModelTextChunk?: (text: string) => void;
  // Single full user-text utterance (from inputAudioTranscription).
  onUserText?: (text: string) => void;
  onTurnComplete?: () => void;
  onInterrupted?: () => void;
  onError?: (err: Error) => void;
  onClose?: (reason: string) => void;
}

export interface SessionHandle {
  sendAudio: (base64Pcm: string) => void;
  sendText: (text: string) => void;
  close: () => void;
  isOpen: () => boolean;
}

export async function openSession(
  config: SessionConfig,
  callbacks: SessionCallbacks,
): Promise<SessionHandle> {
  const ai = new GoogleGenAI({
    apiKey: config.ephemeralToken,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  let closed = false;

  const session: Session = await ai.live.connect({
    model: config.model,
    // Config is locked into the ephemeralToken's liveConnectConstraints
    // (server-side). Empty here.
    config: {},
    callbacks: {
      onopen: () => callbacks.onOpen?.(),
      onmessage: (msg: LiveServerMessage) => {
        // Audio comes through at top-level message.data, not nested in
        // modelTurn.parts (despite what the AI Studio reference shows).
        if (msg.data) {
          callbacks.onModelAudio?.(msg.data);
        }
        const out = msg.serverContent?.outputTranscription;
        if (out?.text) callbacks.onModelTextChunk?.(out.text);
        const inn = msg.serverContent?.inputTranscription;
        if (inn?.text) callbacks.onUserText?.(inn.text);
        if (msg.serverContent?.interrupted) callbacks.onInterrupted?.();
        if (msg.serverContent?.turnComplete) callbacks.onTurnComplete?.();
      },
      onerror: (e: ErrorEvent) => callbacks.onError?.(new Error(e.message)),
      onclose: (e: CloseEvent) => {
        closed = true;
        callbacks.onClose?.(e.reason ?? 'closed');
      },
    },
  });

  return {
    sendAudio: (base64Pcm) => {
      if (closed) return;
      session.sendRealtimeInput({
        audio: { data: base64Pcm, mimeType: 'audio/pcm;rate=16000' },
      });
    },
    sendText: (text) => {
      if (closed) return;
      session.sendRealtimeInput({ text });
    },
    close: () => {
      if (closed) return;
      closed = true;
      session.close();
    },
    isOpen: () => !closed,
  };
}
