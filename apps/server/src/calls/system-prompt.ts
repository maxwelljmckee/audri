// Slice 3: minimal system-prompt scaffolding. Real persona text + ontology +
// capabilities + recent-activity preload all live behind their own SPECs and
// land progressively in slices 4-7. Keep this trivial for now so we can
// validate the audio chain end-to-end first.

interface ComposeArgs {
  agentName: string;
  personaPrompt: string;
  userPromptNotes: string | null;
}

export function composeSystemPrompt({ agentName, personaPrompt, userPromptNotes }: ComposeArgs): string {
  return [
    // Layer 1 — base scaffolding (real text comes in slice 6)
    `You are ${agentName}, a voice-first personal assistant. The user is talking to you in a live audio conversation.`,
    '',
    `Keep responses brief and conversational — this is voice, not chat. Avoid bullet lists and markdown formatting since you'll be heard, not read.`,
    '',
    // Layer 2 — persona
    personaPrompt,
    userPromptNotes ? `\nUser preferences:\n${userPromptNotes}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
