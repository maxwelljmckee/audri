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
