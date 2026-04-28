// Static seed data per specs/onboarding.md.
// Pages have agent_abstract per the templates in §"agent_abstract stock templates".
// All seeded pages start with empty wiki_sections — onboarding interview fills profile;
// agent-scope ingestion fills agent pages; todo buckets stay empty containers.

export const ASSISTANT_PERSONA_PROMPT = `You are Audri, a voice-first personal assistant. You learn who the user is over time and help them think clearly. You maintain a personal knowledge graph (their wiki) and use it to ground every conversation.

Voice: friendly, warm, concise, curious, honest. Match their energy without being sycophantic. Don't over-explain. Don't ask permission for trivial things — do them and surface them. Ask permission for expensive or hard-to-reverse actions.

Serve the user's interests, not the urge to seem helpful.`;

// Gemini Live default voice. Other options: Puck, Charon, Kore, Fenrir, Leda, Orus, Zephyr.
export const ASSISTANT_VOICE = 'Aoede';

// Slug stays 'assistant' (stable identifier for routing, page slugs, etc.).
// Name = 'Audri' so the model self-identifies correctly in the prompt and
// during conversation.
export const ASSISTANT_AGENT = {
  slug: 'assistant',
  name: 'Audri',
  voice: ASSISTANT_VOICE,
  personaPrompt: ASSISTANT_PERSONA_PROMPT,
} as const;

// Agent-scope pages (5). Root + 4 children, all `type='agent'`, agent_id set.
export const AGENT_SCOPE_PAGES = [
  { slug: 'assistant', title: 'Assistant', agentAbstract: 'Private notes about the user, kept by the Assistant.', isRoot: true },
  { slug: 'assistant/observations', title: 'Observations', agentAbstract: 'Observations kept by the Assistant.' },
  { slug: 'assistant/recurring-themes', title: 'Recurring themes', agentAbstract: 'Recurring themes kept by the Assistant.' },
  { slug: 'assistant/preferences-noted', title: 'Preferences noted', agentAbstract: 'Preferences noted kept by the Assistant.' },
  { slug: 'assistant/open-questions', title: 'Open questions', agentAbstract: 'Open questions kept by the Assistant.' },
] as const;

// User-scope profile pages (10). Root + 9 children, all `type='profile'`.
export const PROFILE_PAGES = [
  { slug: 'profile', title: 'Profile', agentAbstract: "The user's profile — who they are, what matters to them.", isRoot: true },
  { slug: 'profile/goals', title: 'Goals', agentAbstract: "The user's goals." },
  { slug: 'profile/values', title: 'Values', agentAbstract: "The user's values." },
  { slug: 'profile/life-history', title: 'Life history', agentAbstract: "The user's life history." },
  { slug: 'profile/health', title: 'Health', agentAbstract: "The user's health." },
  { slug: 'profile/work', title: 'Work', agentAbstract: "The user's work." },
  { slug: 'profile/interests', title: 'Interests', agentAbstract: "The user's interests." },
  { slug: 'profile/relationships', title: 'Relationships', agentAbstract: "The user's relationships." },
  { slug: 'profile/preferences', title: 'Preferences', agentAbstract: "The user's preferences." },
  { slug: 'profile/psychology', title: 'Psychology', agentAbstract: "The user's psychology." },
] as const;

// User-scope todo pages (5). Root + 4 status buckets, all `type='todo'`.
// Slugs are path-style per specs/onboarding.md so server/worker code can
// look up buckets by canonical slug (e.g. `todos/todo`, `todos/done`).
export const TODO_PAGES = [
  { slug: 'todos', title: 'Todos', agentAbstract: "The user's todos.", isRoot: true },
  { slug: 'todos/todo', title: 'To do', agentAbstract: 'Todos that are pending.' },
  { slug: 'todos/in-progress', title: 'In progress', agentAbstract: 'Todos that are in-progress.' },
  { slug: 'todos/done', title: 'Done', agentAbstract: 'Todos that are done.' },
  { slug: 'todos/archived', title: 'Archived', agentAbstract: 'Todos that are archived.' },
] as const;
