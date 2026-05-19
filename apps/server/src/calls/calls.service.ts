import { randomUUID } from 'node:crypto';
import { agents, and, callTranscripts, db, eq } from '@audri/shared/db';
import { LIVE_MODEL, getGeminiClient } from '@audri/shared/gemini';
import {
  EndSensitivity,
  Modality,
  StartSensitivity,
  ThinkingLevel,
  type Tool,
} from '@google/genai';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AGENT_FUNCTION_TOOLS } from '../agent-tools/declarations.js';
import { loadGenericCallContext, renderPreloadBlock } from './preload.js';
import { composeSystemPrompt } from './live-agent-prompt.js';

// Live (audio) tool set: shared function declarations + Gemini's native
// googleSearch grounding. Model handles googleSearch internally; no
// client fulfillment needed. Billed per request — prompt steers the
// model toward wiki-first / web-conservative.
const LIVE_TOOLS_AUDIO: Tool[] = [...AGENT_FUNCTION_TOOLS, { googleSearch: {} }];

export interface StartCallArgs {
  userId: string;
  agentSlug: string;
  callType: 'generic' | 'onboarding';
  incognito: boolean;
}

export interface StartCallResult {
  sessionId: string;
  // Ephemeral token for direct Gemini Live WebSocket.
  ephemeralToken: string;
  // Model name the token was minted against — mobile passes this through
  // to ai.live.connect().
  model: string;
  voice: string;
  // Time after which the audio token will be rejected by Google.
  expiresAt: string;
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  async startCall({
    userId,
    agentSlug,
    callType,
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
    const callContext =
      callType === 'generic' ? await loadGenericCallContext(userId, agent.id) : null;
    const preloadBlock = callContext ? renderPreloadBlock(callContext) : '';

    const systemInstruction = composeSystemPrompt({
      agentName: agent.name,
      personaPrompt: agent.personaPrompt,
      userPromptNotes: agent.userPromptNotes,
      callType,
      preloadBlock,
      modality: 'audio',
      customRules: callContext?.customRules,
      knobCatalog: callContext?.knobCatalog,
    });

    // Mint an ephemeral token bound to the Live config. Persona stays
    // server-side; client only sees the opaque token.
    const expireAt = new Date(Date.now() + 30 * 60 * 1000); // 30min

    const tokenResp = await getGeminiClient().authTokens.create({
      config: {
        uses: 1,
        expireTime: expireAt.toISOString(),
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            // Stream both sides as text so we can build a turn-tagged
            // transcript on the client + persist it for ingestion.
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: agent.voice } },
            },
            // Server-side VAD. Tuned per sandbox: low start sensitivity
            // (don't false-trigger on noise), high end sensitivity + long
            // silence window so natural pauses don't end turns prematurely.
            realtimeInputConfig: {
              automaticActivityDetection: {
                startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
                prefixPaddingMs: 300,
                silenceDurationMs: 1500,
              },
            },
            // Bumped above the model's MINIMAL default so the agent gets
            // a small reasoning budget for tool-use decisions + multi-
            // step intent without paying for full reasoning latency on
            // every turn.
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            systemInstruction: { parts: [{ text: systemInstruction }] },
            tools: LIVE_TOOLS_AUDIO,
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

    this.logger.log({ userId, agentSlug, sessionId, incognito }, 'call started');
    return {
      sessionId,
      ephemeralToken,
      model: LIVE_MODEL,
      voice: agent.voice,
      expiresAt: expireAt.toISOString(),
    };
  }
}
