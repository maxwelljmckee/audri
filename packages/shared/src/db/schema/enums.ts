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
