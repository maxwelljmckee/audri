// Identity / Persona — per-user identity tuning. The persona_prompt column
// on the agent row carries the agent's character traits (set at agent
// creation, editable later); user_prompt_notes carries free-form user
// preferences that further tune voice. Both append to the prompt as
// trailing identity-shaping content.

export interface PersonaArgs {
  personaPrompt: string;
  userPromptNotes: string | null;
}

export function buildPersona(args: PersonaArgs): string {
  const parts: string[] = [];
  if (args.personaPrompt) {
    parts.push(args.personaPrompt);
  }
  if (args.userPromptNotes) {
    parts.push(`\nUser preferences:\n${args.userPromptNotes}`);
  }
  return parts.join('\n');
}
