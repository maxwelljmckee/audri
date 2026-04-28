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
