// Research plugin handler — Pro call with Google grounded search to produce
// a structured ResearchOutput. Per specs/research-task-prompt.md.
//
// Note: Gemini's grounded-search mode and `responseSchema` are mutually
// exclusive (the SDK / model rejects schema constraints when googleSearch is
// enabled). So we instruct the model to emit JSON in the prompt and parse +
// validate post-hoc with zod.

import { type Tool } from '@google/genai';
import { getGeminiClient } from '@audri/shared/gemini';
import { z } from 'zod';
import { logger } from '../logger.js';

// gemini-3.1-pro-preview supports grounded search. Override via env for dev.
const RESEARCH_MODEL = process.env.RESEARCH_MODEL ?? 'gemini-3.1-pro-preview';

export const ResearchPayloadZ = z.object({
  query: z.string().min(1),
  context_summary: z.string().optional(),
  source_transcript_id: z.string().uuid().optional(),
  source_turn_id: z.string().optional(),
  user_profile_brief: z
    .object({
      name: z.string().optional(),
      interests_summary: z.string().optional(),
    })
    .optional(),
  preferred_depth: z.enum(['overview', 'detailed']).optional(),
});
export type ResearchPayload = z.infer<typeof ResearchPayloadZ>;

const FindingZ = z.object({
  heading: z.string().min(1),
  content: z.string().min(1),
  citation_indices: z.array(z.number().int().nonnegative()),
});

export const ResearchOutputZ = z.object({
  query: z.string(),
  summary: z.string().min(1),
  findings: z.array(FindingZ).min(1),
  citations: z
    .array(
      z.object({
        url: z.string().url().or(z.string().min(1)),
        title: z.string(),
        snippet: z.string(),
      }),
    )
    .default([]),
  follow_up_questions: z.array(z.string()).optional(),
  notes_for_user: z.string().optional(),
});
export type ResearchOutput = z.infer<typeof ResearchOutputZ>;

export interface ResearchHandlerResult {
  output: ResearchOutput;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
}

const SYSTEM_PROMPT = `You are Audri's research handler. You are NOT in conversation with the user — you produce a written research report that the user will read post-task.

# Goal
Given a research query, produce a thorough, well-cited written report.

# Tool use
You have access to Google Search via grounding. Use it AGGRESSIVELY for any factual claim — better to over-ground than to assert without sources. Every substantive finding should be backed by at least one citation drawn from search results.

# Voice
- Direct and factual. No hype. No "great question!" or "I'd love to help."
- Acknowledge uncertainty where present.
- Don't roleplay any persona — this is a research artifact, not a conversation.

# Length + depth
Default ('overview'):
- Summary: 2-4 sentences
- Findings: 3-6 headings, each ~150-300 words
- Total: ~1500-2500 words

If the payload's preferred_depth is 'detailed':
- Summary: 4-6 sentences
- Findings: 5-10 headings, each ~250-500 words
- Total: ~3500-5000 words

# Citation discipline
- Every finding's content makes at least one cited claim
- citation_indices reference the global \`citations\` array (1-indexed; 0 reserved for "no citation")
- Don't fabricate citations — if grounded search returned nothing useful, the \`notes_for_user\` field says so explicitly
- Domain diversity preferred where possible

# Refusal / out-of-scope
- If the query isn't actually researchable (e.g. "research my own goals"), produce zero findings and a notes_for_user explaining why
- If the query is harmful, refuse via notes_for_user
- If the query implies access to private data you don't have (email, calendar), explain the gap

# Output format
Output ONLY a single JSON object with EXACTLY these top-level keys — no preamble, no markdown fences:

{
  "query": "<echo the input query verbatim>",
  "summary": "<2-4 sentence executive summary>",
  "findings": [
    {
      "heading": "<short heading>",
      "content": "<markdown prose; multi-paragraph allowed>",
      "citation_indices": [1, 3]
    }
  ],
  "citations": [
    { "url": "...", "title": "...", "snippet": "..." }
  ],
  "follow_up_questions": ["<2-4 questions the research surfaced>"],
  "notes_for_user": "<optional caveats / gaps / 'couldn't find' notes>"
}

If you didn't gather any citations from grounding, leave \`citations\` as an empty array and explain in \`notes_for_user\`.`;

function composeUserMessage(payload: ResearchPayload): string {
  const parts: string[] = [`# Research query\n\n${payload.query}`];
  if (payload.context_summary) {
    parts.push(`\n# Context from the originating conversation\n\n${payload.context_summary}`);
  }
  if (payload.user_profile_brief) {
    const brief = payload.user_profile_brief;
    const lines: string[] = [];
    if (brief.name) lines.push(`Name: ${brief.name}`);
    if (brief.interests_summary) lines.push(`Interests: ${brief.interests_summary}`);
    if (lines.length > 0) {
      parts.push(`\n# About the user\n\n${lines.join('\n')}`);
    }
  }
  if (payload.preferred_depth) {
    parts.push(`\n# Depth\n\nUse "${payload.preferred_depth}" length guidelines.`);
  }
  return parts.join('\n');
}

export async function runResearch(payload: ResearchPayload): Promise<ResearchHandlerResult> {
  const userMessage = composeUserMessage(payload);

  const tools: Tool[] = [{ googleSearch: {} }];

  const resp = await getGeminiClient().models.generateContent({
    model: RESEARCH_MODEL,
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      tools,
      temperature: 0.4,
    },
  });

  const text = resp.text;
  if (!text) throw new Error('research handler: empty response');

  // Tolerate stray prose around the JSON object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    logger.warn({ textHead: text.slice(0, 300) }, 'research handler: non-JSON response');
    throw new Error('research handler: response did not contain JSON');
  }

  const parsed = JSON.parse(text.slice(start, end + 1));
  // Echo the input query if the model dropped it (defensive).
  if (!parsed.query) parsed.query = payload.query;
  const validated = ResearchOutputZ.parse(parsed);

  // Token usage — best-effort extraction. Defaults to 0 if absent.
  const meta = (resp as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
    .usageMetadata;
  const tokensIn = meta?.promptTokenCount ?? 0;
  const tokensOut = meta?.candidatesTokenCount ?? 0;

  return {
    output: validated,
    modelUsed: RESEARCH_MODEL,
    tokensIn,
    tokensOut,
  };
}
