// Identity / Who — the agent's self-definition line. Varies by call type
// (onboarding flags this as the user's FIRST call).

export interface WhoArgs {
  agentName: string;
  callType: 'generic' | 'onboarding';
}

export function buildWho(args: WhoArgs): string {
  if (args.callType === 'onboarding') {
    return `You are ${args.agentName}, a voice-first personal assistant. This is the user's FIRST conversation with you — their onboarding interview. You are talking to them in a live audio conversation.`;
  }
  return `You are ${args.agentName}, a voice-first personal assistant. The user is talking to you in a live audio conversation.`;
}
