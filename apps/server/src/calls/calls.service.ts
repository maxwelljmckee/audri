import { randomUUID } from 'node:crypto';
import { agents, and, callTranscripts, db, eq } from '@audri/shared/db';
import { LIVE_MODEL, getGeminiClient } from '@audri/shared/gemini';
import {
  EndSensitivity,
  type FunctionDeclaration,
  Modality,
  StartSensitivity,
  ThinkingLevel,
  type Tool,
  Type,
} from '@google/genai';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { loadGenericCallContext, renderPreloadBlock } from './preload.js';
import { composeSystemPrompt } from './system-prompt.js';

// Function declarations for live-agent tool calls. Backed by endpoints in
// calls.controller.ts (tools/{search_wiki, fetch_page, search_transcripts,
// fetch_transcript}). googleSearch grounding is a built-in Gemini tool —
// model handles it internally, no client fulfillment needed. Wiki +
// transcript tools cost roughly nothing on each call (SQL only); googleSearch
// grounding bills per request, so the prompt steers the model toward
// wiki-first / web-conservative.
const SEARCH_WIKI_DECL: FunctionDeclaration = {
  name: 'search_wiki',
  description:
    "Search the user's personal notes (wiki) for content related to a topic. Cheap; use freely whenever you suspect the user has notes on something. Returns up to 5 best-matching pages with a short snippet from each.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description:
          "Free-form natural-language search query — the topic or entity you're looking up. Example: 'consensus social technology' or 'Sarah relationship'.",
      },
    },
    required: ['query'],
  },
};

const FETCH_PAGE_DECL: FunctionDeclaration = {
  name: 'fetch_page',
  description:
    "Fetch the full content of a single wiki page by its slug. Use after a search_wiki result if you need the page's full content, or to read a page the user references by name. Returns title + abstract + all sections.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      slug: {
        type: Type.STRING,
        description:
          "The wiki page slug (e.g. 'projects/consensus', 'profile/goals', 'people/sarah'). Slugs come from search_wiki results or the preload's Notes-structure section.",
      },
    },
    required: ['slug'],
  },
};

const SEARCH_TRANSCRIPTS_DECL: FunctionDeclaration = {
  name: 'search_transcripts',
  description:
    'Search the user\'s past call transcripts for content they discussed in earlier conversations. Cheap; use whenever the user references something they said before ("the books we discussed", "what I told you about my project last week"). Returns up to 5 matching transcripts with date + a snippet of the matching turn. Transcripts are the raw conversational record — distinct from the wiki, which holds distilled knowledge.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description:
          "Free-form natural-language search query over past call content. Example: 'books reading list' or 'Sarah co-founder'.",
      },
    },
    required: ['query'],
  },
};

const FETCH_TRANSCRIPT_DECL: FunctionDeclaration = {
  name: 'fetch_transcript',
  description:
    'Fetch the full turn-by-turn content of a single past call transcript by its id. Use after search_transcripts when you need to read the full conversation, not just the matching snippet. Returns ordered turns with role + text. Long transcripts truncate to the last 60 turns (a `truncated` flag indicates when this happens).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      transcript_id: {
        type: Type.STRING,
        description: 'The transcript id returned by search_transcripts (a UUID string).',
      },
    },
    required: ['transcript_id'],
  },
};

const LIVE_TOOLS: Tool[] = [
  {
    functionDeclarations: [
      SEARCH_WIKI_DECL,
      FETCH_PAGE_DECL,
      SEARCH_TRANSCRIPTS_DECL,
      FETCH_TRANSCRIPT_DECL,
    ],
  },
  // Gemini-native grounded web search. Model handles internally; no client
  // fulfillment. Billed per request — use conservatively (steered by prompt).
  { googleSearch: {} },
];

export interface StartCallArgs {
  userId: string;
  agentSlug: string;
  callType: 'generic' | 'onboarding';
  modality: 'audio' | 'text';
  incognito: boolean;
}

export interface StartCallResult {
  sessionId: string;
  ephemeralToken: string;
  model: string;
  voice: string;
  // Time after which the token will be rejected by Google.
  expiresAt: string;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  async startCall({
    userId,
    agentSlug,
    callType,
    modality,
    incognito,
  }: StartCallArgs): Promise<StartCallResult> {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.slug, agentSlug)))
      .limit(1);
    if (!agent) throw new NotFoundException(`agent not found: ${agentSlug}`);

    const sessionId = randomUUID();
    // Generic calls preload profile + agent notes + recent activity. Onboarding
    // intentionally starts cold — the user hasn't given the model anything yet.
    const preloadBlock =
      callType === 'generic'
        ? renderPreloadBlock(await loadGenericCallContext(userId, agent.id))
        : '';

    const systemInstruction = composeSystemPrompt({
      agentName: agent.name,
      personaPrompt: agent.personaPrompt,
      userPromptNotes: agent.userPromptNotes,
      callType,
      preloadBlock,
    });

    const expireAt = new Date(Date.now() + 30 * 60 * 1000); // 30min

    // Text-modality sessions skip the audio-only config: no audio
    // transcription (input is text already), no speech voice config, no
    // server-side VAD. responseModalities flips to TEXT.
    const audioOnlyConfig =
      modality === 'audio'
        ? {
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: agent.voice } },
            },
            // Server-side VAD. Tuned per sandbox: low start sensitivity (don't
            // false-trigger on noise), high end sensitivity + long silence
            // window so natural pauses don't end turns prematurely.
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
                prefixPaddingMs: 300,
                silenceDurationMs: 1500,
              },
            },
          }
        : {};

    // Mint an ephemeral token bound to the live config. Persona stays
    // server-side; client only sees the opaque token.
    const tokenResp = await getGeminiClient().authTokens.create({
      config: {
        uses: 1,
        expireTime: expireAt.toISOString(),
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: [modality === 'text' ? Modality.TEXT : Modality.AUDIO],
            ...audioOnlyConfig,
            // Bumped above the model's MINIMAL default so the agent gets a
            // small reasoning budget for tool-use decisions + multi-step
            // intent without paying for full reasoning latency on every turn.
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction: { parts: [{ text: systemInstruction }] },
            tools: LIVE_TOOLS,
          },
        },
        httpOptions: { apiVersion: 'v1alpha' },
      },
    });

    const ephemeralToken = tokenResp.name;
    if (!ephemeralToken) {
      this.logger.error({ tokenResp }, 'gemini ephemeral token missing name');
      throw new Error('failed to mint gemini token');
    }

    // Pre-create the call_transcripts row so we have something to attach to
    // at /end. Status = in-progress (started_at set, ended_at null).
    // Incognito sessions skip this — no row, no /end, no ingestion.
    if (!incognito) {
      await db
        .insert(callTranscripts)
        .values({
          userId,
          agentId: agent.id,
          sessionId,
          callType,
          startedAt: new Date(),
        })
        .onConflictDoNothing({ target: callTranscripts.sessionId });
    }

    this.logger.log({ userId, agentSlug, sessionId, modality, incognito }, 'call started');
    return {
      sessionId,
      ephemeralToken,
      model: LIVE_MODEL,
      voice: agent.voice,
      expiresAt: expireAt.toISOString(),
    };
  }
}
