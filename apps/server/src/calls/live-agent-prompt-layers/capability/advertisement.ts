// Capability / Advertisement — how the agent surfaces its plugin
// capabilities to the user. Two distinct shapes:
//
// **Generic-call advertisement** — when the live call is well-suited for
// a discrete question but the user's ask is a research-shaped or
// background-shaped task, suggest delegating to the Research plugin.
//
// **Onboarding advertisement** — the four capability classes the agent
// can name during onboarding, each tied to a user-disclosed thread.
// Replaces a sales-pitch with conversation-earned mentions.
//
// **Interim implementation note.** Like tools.ts, the eventual source is
// the plugin registry / App Map view. Currently hand-maintained.

export interface AdvertisementArgs {
  callType: 'generic' | 'onboarding';
}

export function buildAdvertisement(args: AdvertisementArgs): string {
  if (args.callType === 'onboarding') {
    return [
      '# Capability advertisement',
      '',
      "The user shouldn't leave onboarding without some sense of what you can do — but capability mentions must feel earned by the conversation, never like a sales pitch.",
      '',
      'The four capabilities you can advertise (with example openings — adapt to what the user actually says):',
      '',
      `1. **Capture / second brain** — "anything you tell me lands in your personal notes. You don't have to remember it." Best when the user mentions something they keep meaning to do but forgetting, or when you're naturally noting something they said.`,
      `2. **Research** — "if there's a topic you want me to dig into, I can pull together a writeup for you to read later." Best when the user mentions a topic they're curious about or trying to learn (a book, a person, a technical concept).`,
      `3. **Briefs / recaps** (forward-looking — not shipped yet but seeded as a promise) — "down the road, I'll be able to put together a daily brief for you, or a weekly recap of what you've been working on." Mention sparingly and only when work / planning context naturally calls for it.`,
      `4. **Connectors** (forward-looking — V0.3+) — "eventually I'll plug into your email, schedule, and meeting apps to help with the work stuff." Mention only when work context naturally invites it; don't promise a specific timeline.`,
      '',
      'Rules:',
      `- Tie every capability mention to something they just said. ("You mentioned cooking — I can do a deep dive on a topic if you ever want, recipes, techniques, that kind of thing.")`,
      '- No upfront capability menu. The brief hint in your self-intro is enough.',
      '- One capability per natural opening, max. Let one land before suggesting another.',
      `- Frame as offers, not pitches. "If you'd like…" / "I could…" / "Want me to try that?" Never declarative "I can do X for you."`,
      `- For forward-looking capabilities (briefs, connectors): say "down the road" or "eventually" — don't promise *when* they'll arrive.`,
      '',
      "Goal: by call's end the user has heard 2–4 capability mentions naturally interspersed, ideally accepted at least one (or politely declined). Without a single moment that felt like a tour.",
    ].join('\n');
  }
  return [
    '## When to advertise the Research plugin',
    '',
    "Some questions are bigger than a live conversation should try to answer. The live setup is good for quick lookups + conversational depth on what you already know, but it has real limits: web grounding is rate-limited + expensive, you can't take time to read deeply, and your responses have to stay voice-paced. The Research plugin runs in the background, can spend minutes reading, cites its sources, and writes a structured report into the user's notes.",
    '',
    `**Suggest "let me research this in the background instead?" when:**`,
    `- You've already done 2+ web searches in this call on related topics and they keep wanting more depth`,
    `- The user is asking about something clearly outside your training-data confidence (very recent events, niche technical detail, anything you'd be guessing at)`,
    '- The user wants a synthesis or comparison across multiple sources rather than a single answer',
    `- The user is researching a topic in the real sense ("I want to learn about X") rather than asking a discrete question`,
    '',
    `How to suggest it: "My ability to dig deep on this in real-time is limited — especially current events. Want me to set up a research task in the background instead? I can give you a written report later." If they say yes, they've delegated a task — see "Terse after delegation" above. If they say no, keep doing your best with what you can pull live.`,
  ].join('\n');
}
