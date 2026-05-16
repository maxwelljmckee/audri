// Shared agent-tool function declarations. Both the Live (voice) and
// chat agents advertise the same wiki + transcript retrieval surface;
// the live agent fulfills via per-tool HTTP endpoints (mobile receives
// onToolCall over the Gemini WebSocket, hits calls.controller.ts), and
// the chat agent fulfills in-process via chat.service.ts's tool loop.
// Either way, the declarations the model sees are identical — keep them
// here so the two agents don't drift on tool semantics over time.
//
// `web_search` lives in chat.service.ts because it's chat-specific
// (Live agent uses googleSearch as a native built-in, which can't ride
// in the same `tools` array as function declarations).

import { type FunctionDeclaration, type Tool, Type } from '@google/genai';

export const SEARCH_WIKI_DECL: FunctionDeclaration = {
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

export const FETCH_PAGE_DECL: FunctionDeclaration = {
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

export const SEARCH_TRANSCRIPTS_DECL: FunctionDeclaration = {
  name: 'search_transcripts',
  description:
    'Search the user\'s past call and chat transcripts for content they discussed in earlier conversations. Cheap; use whenever the user references something they said before ("the books we discussed", "what I told you about my project last week"). Returns up to 5 matching transcripts with date + a snippet of the matching turn. Transcripts are the raw conversational record — distinct from the wiki, which holds distilled knowledge.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description:
          "Free-form natural-language search query over past call/chat content. Example: 'books reading list' or 'Sarah co-founder'.",
      },
    },
    required: ['query'],
  },
};

export const FETCH_TRANSCRIPT_DECL: FunctionDeclaration = {
  name: 'fetch_transcript',
  description:
    'Fetch the full turn-by-turn content of a single past transcript by its id. Use after search_transcripts when you need to read the full conversation, not just the matching snippet. Returns ordered turns with role + text. Long transcripts truncate to the last 60 turns (a `truncated` flag indicates when this happens).',
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

// Pre-bundled Tool[] entry exposing all four declarations as a single
// functionDeclarations group — the shape the Gemini SDK accepts in the
// LiveConnectConfig.tools / generateContentParameters.config.tools
// fields. Consumers that need additional tools (e.g. chat adds
// web_search; voice adds googleSearch) spread this and append.
export const AGENT_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  SEARCH_WIKI_DECL,
  FETCH_PAGE_DECL,
  SEARCH_TRANSCRIPTS_DECL,
  FETCH_TRANSCRIPT_DECL,
];

export const AGENT_FUNCTION_TOOLS: Tool[] = [{ functionDeclarations: AGENT_FUNCTION_DECLARATIONS }];
