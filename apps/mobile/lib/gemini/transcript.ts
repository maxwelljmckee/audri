// Turn-tagged transcript builder.
//
// Gemini Live emits transcription text in two streams:
//   - inputTranscription  — what the user said (single complete message per utterance)
//   - outputTranscription — what the model said (chunked; flush on turnComplete or interrupt)
//
// We assemble these into a flat newest-last list of { id, role, text, t }.

export type TranscriptRole = 'user' | 'agent';

export interface TranscriptTurn {
  id: string; // 'turn-N' assigned in append order
  role: TranscriptRole;
  text: string;
  t: number; // ms timestamp on creation
}

export interface TranscriptHandle {
  appendUserText: (text: string) => void;
  appendAgentTextChunk: (chunk: string) => void;
  // Call on Gemini turnComplete OR interrupted: flush any buffered model text
  // as a turn entry.
  finalizeAgentTurn: () => void;
  getAll: () => TranscriptTurn[];
  reset: () => void;
}

export function createTranscript(): TranscriptHandle {
  const turns: TranscriptTurn[] = [];
  let agentBuffer = '';
  let nextId = 0;

  function nextTurnId(): string {
    return `turn-${nextId++}`;
  }

  return {
    appendUserText(text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      turns.push({ id: nextTurnId(), role: 'user', text: trimmed, t: Date.now() });
    },
    appendAgentTextChunk(chunk) {
      agentBuffer += chunk;
    },
    finalizeAgentTurn() {
      const final = agentBuffer.trim();
      agentBuffer = '';
      if (!final) return;
      turns.push({ id: nextTurnId(), role: 'agent', text: final, t: Date.now() });
    },
    getAll() {
      return turns.slice();
    },
    reset() {
      turns.length = 0;
      agentBuffer = '';
      nextId = 0;
    },
  };
}
