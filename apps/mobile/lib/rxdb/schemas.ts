// RxDB JSON-schema definitions for the wiki collections.
//
// Column names use snake_case to match the Supabase / Postgres column names —
// rxdb-supabase syncs row shape verbatim, so we mirror the cloud schema here.
// (Drizzle uses camelCase in TS but maps to snake_case at the DB layer.)
//
// MVP collections: wiki_pages + wiki_sections only. Other tables join the
// sync set as later slices need them.

import type { RxJsonSchema } from 'rxdb';

export interface WikiPageDoc {
  id: string;
  user_id: string;
  scope: 'user' | 'agent';
  type: string;
  slug: string;
  parent_page_id: string | null;
  title: string;
  agent_abstract: string;
  abstract: string | null;
  frontmatter: Record<string, unknown>;
  // Structured per-person metadata (handles, socials, ask-for, etc.).
  // Always-null for non-person pages by convention. v0.2 substrate.
  person_metadata: Record<string, unknown> | null;
  // 'stub' | 'moderate' | 'full'. Coarse signal of how much we know about
  // the entity. Nullable; populated by future ingestion. v0.2 substrate.
  maturity: 'stub' | 'moderate' | 'full' | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  tombstoned_at: string | null;
}

export interface WikiSectionDoc {
  id: string;
  page_id: string;
  title: string | null;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  tombstoned_at: string | null;
}

export const wikiPageSchema: RxJsonSchema<WikiPageDoc> = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 36 },
    user_id: { type: 'string', maxLength: 36 },
    scope: { type: 'string', enum: ['user', 'agent'], maxLength: 8 },
    // Indexed string field — RxDB requires fixed maxLength so the indexer
    // can binary-sort. Page-type values fit in 16 chars.
    type: { type: 'string', maxLength: 16 },
    slug: { type: 'string' },
    parent_page_id: { type: ['string', 'null'] },
    title: { type: 'string' },
    agent_abstract: { type: 'string' },
    abstract: { type: ['string', 'null'] },
    frontmatter: { type: 'object' },
    person_metadata: { type: ['object', 'null'] },
    maturity: { type: ['string', 'null'], enum: ['stub', 'moderate', 'full', null], maxLength: 8 },
    agent_id: { type: ['string', 'null'] },
    created_at: { type: 'string', maxLength: 32 },
    // Indexed (in [type, updated_at]) — needs maxLength. ISO timestamp fits.
    updated_at: { type: 'string', maxLength: 32 },
    tombstoned_at: { type: ['string', 'null'] },
  },
  required: [
    'id',
    'user_id',
    'scope',
    'type',
    'slug',
    'title',
    'agent_abstract',
    'frontmatter',
    'created_at',
    'updated_at',
  ],
  indexes: ['type', ['type', 'updated_at']],
};

export const wikiSectionSchema: RxJsonSchema<WikiSectionDoc> = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 36 },
    page_id: { type: 'string', maxLength: 36 },
    title: { type: ['string', 'null'] },
    content: { type: 'string' },
    sort_order: { type: 'number', minimum: 0, maximum: 99999, multipleOf: 1 },
    created_at: { type: 'string', maxLength: 32 },
    updated_at: { type: 'string', maxLength: 32 },
    tombstoned_at: { type: ['string', 'null'] },
  },
  required: ['id', 'page_id', 'content', 'sort_order', 'created_at', 'updated_at'],
  indexes: ['page_id', ['page_id', 'sort_order']],
};

// Findings carry the citation_indices that point into the citations array
// stored on the same row. Citations themselves are also written to
// research_output_sources server-side but the wiki-rendering UI reads them
// from this JSONB blob since it's a single-row fetch.
export interface ResearchFindingDoc {
  heading: string;
  content: string;
  citation_indices: number[];
}

export interface ResearchCitationDoc {
  url: string;
  title: string;
  snippet: string;
}

export interface ResearchOutputDoc {
  id: string;
  user_id: string;
  agent_tasks_id: string;
  query: string;
  title: string;
  summary: string;
  findings: ResearchFindingDoc[];
  citations: ResearchCitationDoc[];
  follow_up_questions: string[];
  notes_for_user: string | null;
  model_used: string;
  tokens_in: number;
  tokens_out: number;
  generated_at: string;
  tombstoned_at: string | null;
}

// Mirrors the agent_tasks Postgres row. Sync exists primarily so plugin
// overlays can render in-flight placeholders for queued / running tasks.
// Once a task succeeds, its result_artifact lands in the corresponding
// kind-specific collection (research_outputs today; podcasts / etc. V1+).
export interface AgentTaskDoc {
  id: string;
  user_id: string;
  todo_page_id: string;
  agent_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  priority: number;
  scheduled_for: string;
  started_at: string | null;
  completed_at: string | null;
  retry_count: number;
  last_error: string | null;
  graphile_job_id: string | null;
  result_artifact_kind: string | null;
  result_artifact_id: string | null;
  created_at: string;
  updated_at: string;
}

export const agentTaskSchema: RxJsonSchema<AgentTaskDoc> = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 36 },
    user_id: { type: 'string', maxLength: 36 },
    todo_page_id: { type: 'string', maxLength: 36 },
    agent_id: { type: ['string', 'null'] },
    // Indexed for filtering by kind + status; bound length to keep the index
    // bounded.
    kind: { type: 'string', maxLength: 32 },
    payload: { type: 'object' },
    status: {
      type: 'string',
      enum: ['pending', 'running', 'succeeded', 'failed', 'cancelled'],
      maxLength: 16,
    },
    priority: { type: 'number', minimum: 0, maximum: 10, multipleOf: 1 },
    scheduled_for: { type: 'string', maxLength: 32 },
    started_at: { type: ['string', 'null'] },
    completed_at: { type: ['string', 'null'] },
    retry_count: { type: 'number', minimum: 0 },
    last_error: { type: ['string', 'null'] },
    graphile_job_id: { type: ['string', 'null'] },
    result_artifact_kind: { type: ['string', 'null'] },
    result_artifact_id: { type: ['string', 'null'] },
    created_at: { type: 'string', maxLength: 32 },
    updated_at: { type: 'string', maxLength: 32 },
  },
  required: [
    'id',
    'user_id',
    'todo_page_id',
    'kind',
    'payload',
    'status',
    'priority',
    'scheduled_for',
    'retry_count',
    'created_at',
    'updated_at',
  ],
  indexes: ['kind', 'status', ['kind', 'status', 'updated_at']],
};

// todos sidecar — owns todo lifecycle (status, parent_page_id association,
// due, completed_at). Mobile reads to render swimlane Todos UX; mobile
// updates status (check-off / archive) and parent_page_id (re-associate
// across swimlanes). Inserts go through ingestion + manual-create paths
// server-side. v0.2.1.
export interface TodoDoc {
  id: string;
  user_id: string;
  page_id: string;
  parent_page_id: string | null;
  // NULL = user owns the todo (default). Non-null FK to agents.id = the
  // named persona owes it back to the user. v0.2 addition 2026-05-11.
  assignee_agent_id: string | null;
  status: 'todo' | 'in-progress' | 'done' | 'archived';
  due_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const todoSchema: RxJsonSchema<TodoDoc> = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 36 },
    user_id: { type: 'string', maxLength: 36 },
    page_id: { type: 'string', maxLength: 36 },
    parent_page_id: { type: ['string', 'null'] },
    assignee_agent_id: { type: ['string', 'null'] },
    status: {
      type: 'string',
      enum: ['todo', 'in-progress', 'done', 'archived'],
      maxLength: 16,
    },
    due_date: { type: ['string', 'null'] },
    completed_at: { type: ['string', 'null'] },
    created_at: { type: 'string', maxLength: 32 },
    updated_at: { type: 'string', maxLength: 32 },
  },
  required: ['id', 'user_id', 'page_id', 'status', 'created_at', 'updated_at'],
  // Read patterns: per-status grouping within a parent_page_id swimlane;
  // sidecar lookup by page_id (1:1 with wiki page).
  indexes: ['page_id', 'status', ['status', 'updated_at']],
};

// agent_open_items — per-persona queue of agent-initiated content (questions
// + info-shares) that the call-side prompt composer reads to drive proactive
// behavior. Mobile reads via the Agents tile; mobile pushes status updates
// (snooze / dismiss). v0.2 substrate.
export interface AgentOpenItemDoc {
  id: string;
  user_id: string;
  agent_id: string;
  kind: 'question' | 'info_share';
  topic: string;
  body_text: string;
  priority: number;
  status: 'pending' | 'surfaced' | 'answered' | 'engaged' | 'dismissed' | 'expired';
  created_by_task_id: string | null;
  cross_domain_links: unknown[];
  created_at: string;
  updated_at: string;
  surfaced_at: string | null;
  resolved_at: string | null;
}

export const agentOpenItemSchema: RxJsonSchema<AgentOpenItemDoc> = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 36 },
    user_id: { type: 'string', maxLength: 36 },
    agent_id: { type: 'string', maxLength: 36 },
    kind: { type: 'string', enum: ['question', 'info_share'], maxLength: 16 },
    topic: { type: 'string' },
    body_text: { type: 'string' },
    priority: { type: 'number', minimum: 0, maximum: 10, multipleOf: 1 },
    status: {
      type: 'string',
      enum: ['pending', 'surfaced', 'answered', 'engaged', 'dismissed', 'expired'],
      maxLength: 16,
    },
    created_by_task_id: { type: ['string', 'null'] },
    cross_domain_links: { type: 'array' },
    created_at: { type: 'string', maxLength: 32 },
    updated_at: { type: 'string', maxLength: 32 },
    surfaced_at: { type: ['string', 'null'] },
    resolved_at: { type: ['string', 'null'] },
  },
  required: [
    'id',
    'user_id',
    'agent_id',
    'kind',
    'topic',
    'body_text',
    'priority',
    'status',
    'cross_domain_links',
    'created_at',
    'updated_at',
  ],
  // Primary read path: composer pulls "pending items for this agent ranked
  // by priority". Index matches the query shape.
  indexes: ['agent_id', ['agent_id', 'status', 'priority']],
};

// call_transcripts — Chat History data source. Mobile reads everything in
// this shape; heavy/PII columns are excluded server-side via publication
// allowlist (migration 0016).
export interface ChatTurn {
  // Shape inferred from existing call_transcripts.content writes. Kept
  // permissive (Record<string, unknown>) to avoid schema-validation
  // tripping on unrecognized turn fields.
  [key: string]: unknown;
}

export interface CallTranscriptDoc {
  id: string;
  user_id: string;
  agent_id: string;
  session_id: string;
  call_type: 'generic' | 'onboarding';
  kind: 'voice' | 'text';
  title: string | null;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  content: ChatTurn[];
  cancelled: boolean;
  end_reason: string | null;
  ingestion_status: 'pending' | 'running' | 'succeeded' | 'failed';
  ingestion_error: string | null;
  created_at: string;
}

export const callTranscriptSchema: RxJsonSchema<CallTranscriptDoc> = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 36 },
    user_id: { type: 'string', maxLength: 36 },
    agent_id: { type: 'string', maxLength: 36 },
    session_id: { type: 'string' },
    call_type: { type: 'string', enum: ['generic', 'onboarding'], maxLength: 16 },
    kind: { type: 'string', enum: ['voice', 'text'], maxLength: 8 },
    title: { type: ['string', 'null'] },
    summary: { type: ['string', 'null'] },
    // Indexed for ORDER BY started_at DESC. ISO timestamp.
    started_at: { type: 'string', maxLength: 32 },
    ended_at: { type: ['string', 'null'] },
    content: { type: 'array' },
    cancelled: { type: 'boolean' },
    end_reason: { type: ['string', 'null'] },
    ingestion_status: {
      type: 'string',
      enum: ['pending', 'running', 'succeeded', 'failed'],
      maxLength: 16,
    },
    ingestion_error: { type: ['string', 'null'] },
    created_at: { type: 'string', maxLength: 32 },
  },
  required: [
    'id',
    'user_id',
    'agent_id',
    'session_id',
    'call_type',
    'kind',
    'started_at',
    'content',
    'cancelled',
    'ingestion_status',
    'created_at',
  ],
  // Primary read pattern: per-user, ORDER BY started_at DESC. Composite
  // index supports both filter + sort.
  indexes: ['started_at', 'ingestion_status', ['ingestion_status', 'started_at']],
};

// wiki_section_transcripts — junction syncing for Chat History cross-refs.
// Read pattern: "for transcript X, what sections were cited?"
export interface WikiSectionTranscriptDoc {
  id: string;
  section_id: string;
  transcript_id: string;
  turn_id: string;
  snippet: string;
  cited_at: string;
}

export const wikiSectionTranscriptSchema: RxJsonSchema<WikiSectionTranscriptDoc> = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 36 },
    section_id: { type: 'string', maxLength: 36 },
    transcript_id: { type: 'string', maxLength: 36 },
    turn_id: { type: 'string' },
    snippet: { type: 'string' },
    cited_at: { type: 'string', maxLength: 32 },
  },
  required: ['id', 'section_id', 'transcript_id', 'turn_id', 'snippet', 'cited_at'],
  indexes: ['transcript_id', 'section_id'],
};

export const researchOutputSchema: RxJsonSchema<ResearchOutputDoc> = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 36 },
    user_id: { type: 'string', maxLength: 36 },
    agent_tasks_id: { type: 'string', maxLength: 36 },
    query: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    findings: { type: 'array' },
    citations: { type: 'array' },
    follow_up_questions: { type: 'array' },
    notes_for_user: { type: ['string', 'null'] },
    model_used: { type: 'string' },
    tokens_in: { type: 'number', minimum: 0 },
    tokens_out: { type: 'number', minimum: 0 },
    // Indexed for ORDER BY generated_at DESC. Validate ISO 8601 — a row
    // arriving without a parseable timestamp is a real bug, surface it
    // rather than silently masking with a render-time fallback.
    generated_at: {
      type: 'string',
      maxLength: 32,
      minLength: 20,
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
    },
    tombstoned_at: { type: ['string', 'null'] },
  },
  required: [
    'id',
    'user_id',
    'agent_tasks_id',
    'query',
    'title',
    'summary',
    'findings',
    'citations',
    'follow_up_questions',
    'model_used',
    'tokens_in',
    'tokens_out',
    'generated_at',
  ],
  indexes: ['generated_at'],
};
