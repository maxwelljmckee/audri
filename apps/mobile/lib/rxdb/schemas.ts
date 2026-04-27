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
