// Text-modality chat orchestrator. The Gemini Live API rejects pure-TEXT
// response modalities ("internal error encountered" / 1011), so chat uses
// the standard `generateContentStream` API and runs the tool-call loop
// server-side. Mobile clients post {history, userText} per turn and read
// chunked text back as the response streams.

import { agents, and, callTranscripts, db, eq } from '@audri/shared/db';
import { getGeminiClient } from '@audri/shared/gemini';
import { checkSpendCap } from '@audri/shared/usage';
import {
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Part,
  type Tool,
  Type,
  type UsageMetadata,
} from '@google/genai';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { loadGenericCallContext, renderPreloadBlock } from '../calls/preload.js';
import { composeSystemPrompt } from '../calls/system-prompt.js';
import { fetchPage, fetchTranscript, searchTranscripts, searchWiki } from '../calls/tools.js';

// Non-Live model. The Live preview rejects TEXT modality; the standard
// chat flash model supports text natively with full function calling +
// googleSearch grounding.
const CHAT_MODEL = 'gemini-2.5-flash';

// Hard cap on tool-loop iterations per turn. Each iteration is one
// `generateContentStream` call; the model can emit function calls that
// loop back. 5 is generous — typical turn calls 0–2 tools.
const MAX_TOOL_ITERATIONS = 5;

// Match the Live agent's tool declarations. Same DB-backed handlers, so
// behaviour is identical to voice-mode tool use.
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
    "Fetch the full content of a single wiki page by its slug. Use after a search_wiki result if you need the page's full content, or to read a page the user references by name.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      slug: { type: Type.STRING, description: 'The wiki page slug.' },
    },
    required: ['slug'],
  },
};
const SEARCH_TRANSCRIPTS_DECL: FunctionDeclaration = {
  name: 'search_transcripts',
  description:
    "Search the user's past call and chat transcripts for content they discussed in earlier conversations. Cheap; use whenever the user references something they said before.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Free-form natural-language search query over past transcript content.',
      },
    },
    required: ['query'],
  },
};
const FETCH_TRANSCRIPT_DECL: FunctionDeclaration = {
  name: 'fetch_transcript',
  description: 'Fetch the full turn-by-turn content of a single past transcript by its id.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      transcript_id: { type: Type.STRING, description: 'The transcript id (UUID).' },
    },
    required: ['transcript_id'],
  },
};

// Function declarations only — googleSearch grounding is incompatible
// with function declarations in the same tools array for some Gemini
// model/SDK combos (returns a generic server-side error rather than a
// clear validation message). Re-add as a separate phase if needed.
const CHAT_TOOLS: Tool[] = [
  {
    functionDeclarations: [
      SEARCH_WIKI_DECL,
      FETCH_PAGE_DECL,
      SEARCH_TRANSCRIPTS_DECL,
      FETCH_TRANSCRIPT_DECL,
    ],
  },
];

export interface ChatTurn {
  role: 'user' | 'agent';
  text: string;
}

export interface ChatTurnArgs {
  userId: string;
  sessionId: string;
  history: ChatTurn[];
  userText: string;
  // Pushes a text chunk to the wire as soon as we have it. The HTTP
  // controller wires this to res.write().
  onChunk: (chunk: string) => void;
}

export interface ChatTurnResult {
  agentText: string;
  usage: UsageMetadata | undefined;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  async runTurn(args: ChatTurnArgs): Promise<ChatTurnResult> {
    const { userId, sessionId, history, userText, onChunk } = args;

    // Validate session — must exist and belong to this user. The chat
    // screen on mount POSTs /calls/start with modality=text, which
    // pre-creates the call_transcripts row we look up here.
    const [session] = await db
      .select({
        id: callTranscripts.id,
        userId: callTranscripts.userId,
        agentId: callTranscripts.agentId,
      })
      .from(callTranscripts)
      .where(eq(callTranscripts.sessionId, sessionId))
      .limit(1);
    if (!session || session.userId !== userId) {
      throw new NotFoundException(`unknown session: ${sessionId}`);
    }

    // Spend-cap enforcement: refuse the turn if the user is over their
    // monthly limit. Matches /calls/start behaviour for live audio.
    const cap = await checkSpendCap(userId);
    if (cap.overCap) {
      const err = new Error('SPEND_CAP_EXCEEDED');
      (err as Error & { spendCap?: typeof cap }).spendCap = cap;
      throw err;
    }

    const [agent] = await db
      .select({
        id: agents.id,
        name: agents.name,
        personaPrompt: agents.personaPrompt,
        userPromptNotes: agents.userPromptNotes,
      })
      .from(agents)
      .where(and(eq(agents.userId, userId), eq(agents.id, session.agentId)))
      .limit(1);
    if (!agent) throw new NotFoundException(`agent not found for session: ${sessionId}`);

    const preloadBlock = renderPreloadBlock(await loadGenericCallContext(userId, agent.id));
    const systemInstruction = composeSystemPrompt({
      agentName: agent.name,
      personaPrompt: agent.personaPrompt,
      userPromptNotes: agent.userPromptNotes,
      callType: 'generic',
      preloadBlock,
      modality: 'text',
    });

    // Convert client history (user/agent) into Gemini Content (user/model).
    // Tool-call exchanges from prior turns aren't carried — they were
    // ephemeral within their own turn; the final agent text is what
    // persists. The model re-derives tool needs per turn.
    const contents: Content[] = [
      ...history.map((turn) => ({
        role: turn.role === 'agent' ? 'model' : 'user',
        parts: [{ text: turn.text }],
      })),
      { role: 'user', parts: [{ text: userText }] },
    ];

    let agentText = '';
    let lastUsage: UsageMetadata | undefined;

    this.logger.log(
      {
        sessionId,
        userId,
        historyTurns: history.length,
        userTextLength: userText.length,
        model: CHAT_MODEL,
      },
      'chat turn starting',
    );

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      let stream: AsyncGenerator<GenerateContentResponse>;
      try {
        stream = await getGeminiClient().models.generateContentStream({
          model: CHAT_MODEL,
          contents,
          config: {
            systemInstruction: { parts: [{ text: systemInstruction }] },
            tools: CHAT_TOOLS,
          },
        });
      } catch (err) {
        this.logger.error(
          {
            err,
            sessionId,
            iteration,
            contentsCount: contents.length,
          },
          'chat generateContentStream rejected',
        );
        throw err;
      }

      const pendingFunctionCalls: FunctionCall[] = [];
      // Buffer the model turn's full part list — text + function calls in
      // the order they arrived — so we can append the entire turn to
      // contents before sending function responses back.
      const modelTurnParts: Part[] = [];

      let chunkCount = 0;
      try {
        for await (const chunk of stream) {
          chunkCount += 1;
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];
          for (const part of parts) {
            if (part.text) {
              onChunk(part.text);
              agentText += part.text;
              modelTurnParts.push({ text: part.text });
            }
            if (part.functionCall) {
              pendingFunctionCalls.push(part.functionCall);
              modelTurnParts.push({ functionCall: part.functionCall });
            }
          }
          if (chunk.usageMetadata) {
            lastUsage = chunk.usageMetadata;
          }
        }
      } catch (err) {
        this.logger.error(
          { err, sessionId, iteration, chunkCount, agentTextLen: agentText.length },
          'chat stream iteration threw',
        );
        throw err;
      }
      this.logger.log(
        {
          sessionId,
          iteration,
          chunkCount,
          pendingFunctionCalls: pendingFunctionCalls.length,
          agentTextLen: agentText.length,
        },
        'chat stream iteration complete',
      );

      if (pendingFunctionCalls.length === 0) {
        // No more tool calls — model is done.
        break;
      }

      // Append the model's turn to contents (including the function calls
      // it just emitted) before responding with tool results.
      contents.push({ role: 'model', parts: modelTurnParts });

      const functionResponseParts: Part[] = [];
      for (const call of pendingFunctionCalls) {
        const result = await this.executeFunctionCall(userId, call);
        functionResponseParts.push({
          functionResponse: { name: call.name ?? 'unknown', response: result },
        });
      }
      // Function responses come back as a single user-role content turn.
      contents.push({ role: 'user', parts: functionResponseParts });

      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        this.logger.warn(
          { sessionId, iteration },
          'chat tool loop hit max iterations — returning partial response',
        );
      }
    }

    // TODO(chat-usage): record per-turn inference cost. Blocked on adding
    // a 'chat_turn' value to the usage_event_kind enum (migration needed).
    // For now chat inference is untracked — voice + ingestion are still
    // captured normally. Backlog before chat-mode ships to production.

    return { agentText, usage: lastUsage };
  }

  // Tool fulfillment. Same handlers the live-agent endpoints in
  // calls.controller.ts use — single source of truth for what each tool
  // returns.
  private async executeFunctionCall(
    userId: string,
    call: FunctionCall,
  ): Promise<Record<string, unknown>> {
    const name = call.name ?? '';
    const args = (call.args ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'search_wiki': {
          const query = typeof args.query === 'string' ? args.query : '';
          const results = await searchWiki(userId, query);
          return { results };
        }
        case 'fetch_page': {
          const slug = typeof args.slug === 'string' ? args.slug : '';
          const page = await fetchPage(userId, slug);
          return page ? { page } : { page: null, error: 'page not found' };
        }
        case 'search_transcripts': {
          const query = typeof args.query === 'string' ? args.query : '';
          // Cap at 5 — same as live-agent tool — to keep tool-loop context tight.
          const results = await searchTranscripts(userId, query, 5);
          return { results };
        }
        case 'fetch_transcript': {
          const transcriptId = typeof args.transcript_id === 'string' ? args.transcript_id : '';
          const transcript = await fetchTranscript(userId, transcriptId);
          return transcript ? { transcript } : { transcript: null, error: 'transcript not found' };
        }
        default:
          return { error: `unknown tool: ${name}` };
      }
    } catch (err) {
      this.logger.error({ err, name }, 'chat tool fulfillment threw');
      return { error: err instanceof Error ? err.message : 'tool failed' };
    }
  }
}
