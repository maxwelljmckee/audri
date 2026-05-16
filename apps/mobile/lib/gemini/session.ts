// Thin typed wrapper around @google/genai's ai.live.connect.
// Knows nothing about audio buffers, transcripts, or the call store.

import {
  type FunctionCall,
  type FunctionResponse,
  GoogleGenAI,
  type GroundingMetadata,
  type LiveServerMessage,
  type Session,
  type UsageMetadata,
} from '@google/genai';

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
  // Model called a function tool. Caller is responsible for fulfilling
  // (typically by hitting the API) and replying via sendToolResponse on the
  // SessionHandle. Tool calls arrive as batches; respond with one
  // FunctionResponse per FunctionCall received (matching `id`).
  onToolCall?: (calls: FunctionCall[]) => void;
  // Grounding metadata for the current model turn — fires whenever the
  // googleSearch grounding tool produces sources. Caller records these to
  // attribute the URLs the agent referenced.
  onGroundingMetadata?: (metadata: GroundingMetadata) => void;
  // Session usage metadata. Gemini Live emits this per-message; the value
  // appears to be cumulative since session start (per the SDK doc string
  // "Usage metadata about model response(s)") — so the caller should
  // last-wins-overwrite rather than sum. Captured at session-end to write
  // a single `call_live` usage_events row.
  onUsageMetadata?: (usage: UsageMetadata) => void;
}

export interface SessionHandle {
  sendAudio: (base64Pcm: string) => void;
  sendText: (text: string) => void;
  sendToolResponse: (responses: FunctionResponse[]) => void;
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
        // Voice mode: model audio is transcribed server-side and arrives
        // in outputTranscription. Text mode: model output streams as
        // text parts directly inside modelTurn.parts. Both route to
        // onModelTextChunk so the caller doesn't need to know which.
        const out = msg.serverContent?.outputTranscription;
        if (out?.text) callbacks.onModelTextChunk?.(out.text);
        const parts = msg.serverContent?.modelTurn?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.text) callbacks.onModelTextChunk?.(part.text);
          }
        }
        const inn = msg.serverContent?.inputTranscription;
        if (inn?.text) callbacks.onUserText?.(inn.text);
        if (msg.serverContent?.interrupted) callbacks.onInterrupted?.();
        if (msg.serverContent?.turnComplete) callbacks.onTurnComplete?.();
        const toolCalls = msg.toolCall?.functionCalls;
        if (toolCalls && toolCalls.length > 0) callbacks.onToolCall?.(toolCalls);
        const grounding = msg.serverContent?.groundingMetadata;
        if (grounding) callbacks.onGroundingMetadata?.(grounding);
        if (msg.usageMetadata) callbacks.onUsageMetadata?.(msg.usageMetadata);
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
    sendToolResponse: (responses) => {
      if (closed) return;
      session.sendToolResponse({ functionResponses: responses });
    },
    close: () => {
      if (closed) return;
      closed = true;
      session.close();
    },
    isOpen: () => !closed,
  };
}
