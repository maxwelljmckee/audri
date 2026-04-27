import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EndSensitivity, Modality, StartSensitivity } from '@google/genai';
import { db, agents, callTranscripts, and, eq } from '@audri/shared/db';
import { LIVE_MODEL, getGeminiClient } from '@audri/shared/gemini';
import { composeSystemPrompt } from './system-prompt.js';

export interface StartCallArgs {
  userId: string;
  agentSlug: string;
  callType: 'generic' | 'onboarding';
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

  async startCall({ userId, agentSlug, callType }: StartCallArgs): Promise<StartCallResult> {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.slug, agentSlug)))
      .limit(1);
    if (!agent) throw new NotFoundException(`agent not found: ${agentSlug}`);

    const sessionId = randomUUID();
    const systemInstruction = composeSystemPrompt({
      agentName: agent.name,
      personaPrompt: agent.personaPrompt,
      userPromptNotes: agent.userPromptNotes,
      callType,
    });

    const expireAt = new Date(Date.now() + 30 * 60 * 1000); // 30min

    // Mint an ephemeral token bound to the live config. Persona stays
    // server-side; client only sees the opaque token.
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
            systemInstruction: { parts: [{ text: systemInstruction }] },
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

    this.logger.log({ userId, agentSlug, sessionId }, 'call started');
    return {
      sessionId,
      ephemeralToken,
      model: LIVE_MODEL,
      voice: agent.voice,
      expiresAt: expireAt.toISOString(),
    };
  }
}
