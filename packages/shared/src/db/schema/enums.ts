import { pgEnum } from 'drizzle-orm/pg-core';

export const wikiScopeEnum = pgEnum('wiki_scope', ['user', 'agent']);

export const pageTypeEnum = pgEnum('page_type', [
  'person',
  'concept',
  'project',
  'place',
  'org',
  'source',
  'event',
  'note',
  'profile',
  'todo',
  'agent',
  // 'braindump' — top-level bucket for unstructured / transient / exploratory
  // notes. Distinct conceptual category from `note` (which is the generic
  // textual page type used for arbitrary notes nested inside a hierarchy).
  // Matches the bucket-page-as-typed-root pattern (profile → 'profile',
  // todos → 'todo', projects → 'project', braindump → 'braindump'). Added
  // 2026-05-10.
  'braindump',
]);

export const editedByEnum = pgEnum('edited_by', ['ai', 'user', 'lint', 'task']);

export const agentTaskStatusEnum = pgEnum('agent_task_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export const agentTaskKindEnum = pgEnum('agent_task_kind', ['research']);

export const wikiLogKindEnum = pgEnum('wiki_log_kind', [
  'ingest',
  'agent_scope_ingest',
  'query',
  'lint',
  'task',
]);

export const usageEventKindEnum = pgEnum('usage_event_kind', [
  'call_live',
  'ingestion_prefilter',
  'ingestion',
  'agent_scope_ingestion',
  'plugin_research',
  'tool_search_wiki',
  'tool_fetch_page',
]);

export const artifactKindEnum = pgEnum('artifact_kind', ['research']);

export const callTypeEnum = pgEnum('call_type', ['generic', 'onboarding']);

// Chat history surfaces both voice calls and (V1+) text-based chats. The
// `kind` flag on call_transcripts distinguishes them so the UI can render
// the right turn view + so future analytics can split by modality.
export const chatKindEnum = pgEnum('chat_kind', ['voice', 'text']);

export const endReasonEnum = pgEnum('end_reason', [
  'user_ended',
  'silence_timeout',
  'network_drop',
  'app_backgrounded',
  'cancelled',
]);

export const ingestionStatusEnum = pgEnum('ingestion_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
]);

// Todo lifecycle status. v0.2.1 sidecar refactor — status moved off the
// wiki hierarchy (no more `todos/todo` / `todos/in-progress` / etc. bucket
// pages) and into a column on the `todos` sidecar table. Lifecycle owned
// entirely by the sidecar from now on; wiki-side todos are creation-only
// shells.
export const todoStatusEnum = pgEnum('todo_status', ['todo', 'in-progress', 'done', 'archived']);

// Claim model (v0.2 substrate). `status` is the contestability of a claim
// against the wiki it lives in: 'supported' = backed by current evidence;
// 'contested' = newer evidence conflicts; 'rejected' = explicitly rebutted
// (kept for audit, not surfaced as fact).
export const claimStatusEnum = pgEnum('claim_status', ['supported', 'contested', 'rejected']);

// agent_open_items queue. `kind` distinguishes gap-filling questions
// (terminate on `answered`) from proactive info-shares (terminate on
// `surfaced` / `engaged`). One table covers both lifecycles per DP-5.
export const agentOpenItemKindEnum = pgEnum('agent_open_item_kind', ['question', 'info_share']);

export const agentOpenItemStatusEnum = pgEnum('agent_open_item_status', [
  'pending',
  'surfaced',
  'answered',
  'engaged',
  'dismissed',
  'expired',
]);

// Tiered maturity of an entity page (person, project, concept, org, ...).
// Coarse signal of "how much do we actually know about this entity?"
// Source: COG-second-brain people-CRM tiering (1 / 3+ / 8+ inbound mentions).
// Stored as nullable; populated by future ingestion logic. Not auto-maintained
// in v0.2 — code that needs current tier should recompute on demand or read
// the cached value with the understanding that it may lag behind reality.
export const wikiMaturityEnum = pgEnum('wiki_maturity', ['stub', 'moderate', 'full']);
