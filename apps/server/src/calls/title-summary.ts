// Lightweight Flash call to title + summarize a call transcript. Inline
// inside /calls/:sessionId/end so the call-history UI has display data the
// moment the user hangs up. Failure is non-fatal — caller persists null on
// either field if this returns null.

import { Logger } from '@nestjs/common';
import { Type } from '@google/genai';
import { getGeminiClient } from '../gemini/gemini.client.js';
import type { TranscriptTurn } from './transcript.types.js';

const FLASH_MODEL = 'gemini-2.5-flash';
const MIN_CHARS_FOR_SUMMARY = 80;

const logger = new Logger('title-summary');

function buildPrompt(userFirstName: string | null): string {
  const personRule = userFirstName
    ? `When referring to the person Audri spoke with, use their first name ("${userFirstName}") OR first-person plural ("We discussed…", "We talked through…"). Vary between the two so it doesn't feel repetitive. NEVER use "The user" or "the user" or "they" as a generic stand-in.`
    : `When referring to the person Audri spoke with, use first-person plural ("We discussed…", "We talked through…"). NEVER use "The user" or "the user" or "they" as a generic stand-in.`;

  return `You will receive a turn-tagged transcript of a voice conversation between a person and "Audri", their personal assistant. Produce a concise title and one-paragraph summary.

Rules:
- Title: 4-8 words, no quotes, no trailing punctuation. Capture the gist of the conversation.
- Summary: 1-3 sentences, past tense.
- ${personRule}
- Skip greetings, pleasantries, and meta-conversation.
- If the transcript is too short or content-free, return both fields as empty strings.`;
}

export interface TitleSummaryResult {
  title: string;
  summary: string;
}

export async function generateTitleSummary(
  transcript: TranscriptTurn[],
  userFirstName: string | null = null,
): Promise<TitleSummaryResult | null> {
  const totalChars = transcript.reduce((acc, t) => acc + (t.text?.length ?? 0), 0);
  if (totalChars < MIN_CHARS_FOR_SUMMARY) return null;

  const flat = transcript
    .map((t) => `[${t.role}] ${t.text}`)
    .join('\n');

  try {
    const resp = await getGeminiClient().models.generateContent({
      model: FLASH_MODEL,
      contents: [{ role: 'user', parts: [{ text: `${buildPrompt(userFirstName)}\n\n---\n${flat}` }] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            summary: { type: Type.STRING },
          },
          required: ['title', 'summary'],
        },
        temperature: 0.4,
        maxOutputTokens: 300,
      },
    });

    const text = resp.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as TitleSummaryResult;
    const title = (parsed.title ?? '').trim();
    const summary = (parsed.summary ?? '').trim();
    if (!title && !summary) return null;
    return { title, summary };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'title-summary generation failed');
    return null;
  }
}
