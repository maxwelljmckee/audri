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

// Agent-scope root (1). Sub-pages are NOT seeded — every `assistant/<area>`
// page is created on-demand by the agent-scope ingestion pass when content
// matches. Same principle as profile/* trim: empty seeded sub-pages aren't
// load-bearing structure; they're noise that misrepresents what the agent
// has actually observed.
//
// General/uncategorized observations land directly on the root as sections;
// sub-pages emerge only for coherent clusters. Canonical sub-page vocabulary
// (all on-demand): assistant/recurring-themes, assistant/preferences-noted
// (load-bearing — operational reference for HOW to engage this user),
// assistant/open-questions. Non-canonical examples (assistant/strengths,
// assistant/blind-spots) may emerge when observations clearly warrant them.
// Vocabulary lives in apps/worker/src/ingestion/agent-scope.ts.
export const AGENT_SCOPE_PAGES = [
  {
    slug: 'assistant',
    title: 'Assistant',
    agentAbstract: 'Private notes about the user, kept by the Assistant.',
    isRoot: true,
  },
] as const;

// User-scope profile root (1). Sub-pages are NOT seeded — every `profile/<area>`
// page is created on-demand by ingestion when transcript content matches.
// Empty seeded sub-pages aren't load-bearing structure; they're noise that
// pollutes the structural-snapshot preload and gives the model a false
// impression of what the user has actually shared.
//
// Canonical profile sub-page vocabulary (all on-demand): goals, life-history,
// health, work, interests, relationships, preferences (the seven the
// onboarding scaffolding directly asks about), plus values and psychology
// (emergent-only — never directly asked about, only filled in from how the
// user talks across the askable areas). Non-canonical sub-pages (e.g.
// profile/finances, profile/spirituality) may be created when content
// warrants and no canonical sub-page fits. The vocabulary lives in the
// Flash + Pro prompts so the ingestion pipeline knows when to propose +
// route. See specs/onboarding.md for the askable/emergent split.
//
// `abstract` is the human-readable subtitle shown in the Notes UI under
// the page title. Distinct from `agentAbstract` (terse, machine-consumed).
// Profile is the evergreen-about-you bucket — content that defines who
// the user IS, not what they're doing transiently.
export const PROFILE_PAGES = [
  {
    slug: 'profile',
    title: 'Profile',
    agentAbstract:
      "The user's profile — evergreen content about who they are, what matters to them, what defines them. Seven askable canonical sub-pages: goals, life-history, health, work, interests, relationships, preferences. Emergent: values, psychology.",
    abstract: 'Everything that makes you, you',
    isRoot: true,
  },
] as const;

// User-scope braindump root (1). Top-level catchall for unstructured /
// transient / exploratory thoughts. Distinct from Profile (evergreen-
// about-you), Projects (active work), Todos (action items). Added
// 2026-05-10 to give transient content a real home — previously it
// awkwardly landed in profile/<area> via fan-out fallback heuristics.
//
// Sub-pages emerge on-demand when content clusters; the root holds
// loose sections by default. Fan-out routing rule (per the v0.2
// prompt revision): if content isn't project-related, isn't evergreen-
// about-the-user, and isn't a task → braindump.
export const BRAINDUMP_PAGES = [
  {
    slug: 'braindump',
    title: 'Braindump',
    agentAbstract:
      "Unstructured/transient/exploratory thoughts. Catchall for stuff that isn't yet a project, isn't evergreen-about-the-user, and isn't a task. Sub-pages emerge as content clusters.",
    abstract: 'Unstructured notes and ideas',
    isRoot: true,
  },
] as const;

// User-scope todo root (1). v0.2.1 sidecar refactor (2026-05-10): status
// buckets dropped — status now lives on the `todos` sidecar table column.
// All individual todo wiki pages nest as direct children of this root
// (flat). The wiki layer is a creation/triggering shell; the Todos plugin
// reads from the sidecar for status + project association rendering.
export const TODO_PAGES = [
  {
    slug: 'todos',
    title: 'Todos',
    agentAbstract:
      "The user's todos. Action items the user wants done. Each individual todo lives as a direct child here; status + project association live on the `todos` sidecar table (not the wiki hierarchy). Hidden from the Notes UI — surfaced via the dedicated Todos plugin.",
    isRoot: true,
  },
] as const;

// User-scope project bucket (1). Root only — flat at MVP. Individual project
// pages are created on-demand by ingestion as direct children. Status sub-
// buckets like `projects/archived` may be added later if/when projects start
// being completed or abandoned. The bucket is one of FOUR legitimate type-
// organized hierarchies (alongside `profile/*`, `todos/*`, `braindump/*`);
// all other page types (concept, person, place, etc.) nest under semantic
// parents or live top-level — never under invented type-bucket pages like
// `concepts` or `places`. See specs/fan-out-prompt.md §4.3 for the full rule.
export const PROJECT_PAGES = [
  {
    slug: 'projects',
    title: 'Projects',
    agentAbstract:
      "The user's active projects. Each project lives as a direct child page; sub-topics nest under their parent project. Active work — distinct from braindump (unstructured exploration) or profile (evergreen about-the-user).",
    abstract: "Things you're working on",
    isRoot: true,
  },
] as const;
