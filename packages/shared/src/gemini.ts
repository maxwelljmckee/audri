import { GoogleGenAI } from '@google/genai';

let _ai: GoogleGenAI | null = null;

// Server-side Gemini client. Holds the long-lived API key. Used only to mint
// ephemeral tokens for clients (see /calls/start) and run server-side LLM
// calls (ingestion, research, etc., later slices).
export function getGeminiClient(): GoogleGenAI {
  if (_ai) return _ai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is required');
  _ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  return _ai;
}

// Locked-in for slice 3. Bumps live in code as Google releases new versions.
export const LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';

// 2.5-generation Live preview for text-modality sessions. The 3.1
// "native audio" model returns WebSocket 1011 ("internal error
// encountered") when configured with responseModalities=[TEXT] — per
// Gemini's own guidance, native-audio models are "highly optimized for
// voice processing" and reject pure-text modalities. The 2.5 Live
// preview pre-dates the native-audio push and accepts text reliably.
//
// Naming mirrors the 3.1 audio model's pattern (<gen>-flash-live-preview);
// the SDK example's `gemini-live-<gen>-flash-preview` form returned 1008
// "not found" on the live bidiGenerateContent endpoint.
export const LIVE_MODEL_TEXT = 'models/gemini-2.5-flash-live-preview';
