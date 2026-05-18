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
  // Hard spending-cap (v0.3.0): pre-flight check at dispatch / handler
  // refused to start because the user's monthly spend exceeds their
  // configured limit. User can retry by raising the cap.
  'blocked_over_cap',
]);

export const agentTaskKindEnum = pgEnum('agent_task_kind', [
  'research',
  // v0.3.0 B1 (Automations) — kinds spawned by recurring_agent_tasks
  // dispatcher. Each has its own handler in the plugin registry.
  'brief_me',
  'recap',
  'stalled_work',
  'dreaming',
  'todo_reminder',
]);

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
  // Cross-call retrieval tools (v0.3.x). SQL-only — zero inference cost,
  // but recorded as 0-cost usage_events for per-tool analytics symmetry
  // with the wiki retrieval tools.
  'tool_search_transcripts',
  'tool_fetch_transcript',
  // Server-side lookup tool — invokes Gemini Flash with googleSearch
  // grounding to fetch structured enrichment data named by an agent_notes
  // rule (e.g. "author + year + premise" for a book). Distinct from
  // `web_search` (which counts the live agent's native googleSearch
  // queries); this row covers the Flash inference + grounding cost on
  // the server-side handler. See apps/server/src/calls/tools.ts → lookup.
  'tool_lookup',
  'web_search',
  // Per-turn text-chat inference. Each /chat/turn call streams Gemini
  // output server-side and writes one row tagged with the cumulative
  // usage_metadata snapshot the SDK emits.
  'chat_turn',
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
  'partial',
  'failed',
  // Hard spending-cap (v0.3.0): /end POST detected the user is over the
  // monthly cap, so the ingestion job was NOT enqueued. Distinct from
  // 'failed' so the Notes pending banner can render a different UX
  // (deep-link to SetLimit rather than retry CTA).
  'skipped_over_cap',
  // Pipeline ran without error but produced ZERO writes (Flash dumped,
  // noteworthiness gate failed, Pro emitted only skipped claims, OR Pro
  // emitted a malformed payload that the commit dropped). Distinct from
  // 'succeeded' so the user can manually retry on the suspicion that
  // something extractable was missed. See feedback_ingestion_failure_modes
  // memory + retry-ingest endpoint.
  'zero_claims',
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

// Upload pipeline (v0.3.0 C4/B2.27). Generic over the kinds the Storage
// tile accepts: textual files now (PDF / markdown / plain / DOCX);
// image + audio reserved for later kinds without a schema change.
// URL ingestion lives in a separate `url_sources` table — different
// lifecycle (no Storage object, no upload step). Distinct from
// ingestion_status because the lifecycle is sequential: extraction
// first (raw text from the file), then ingestion (fan-out into wiki).
export const uploadKindEnum = pgEnum('upload_kind', ['pdf', 'markdown', 'plain', 'docx']);

export const uploadExtractionStatusEnum = pgEnum('upload_extraction_status', [
  // Row inserted via POST /uploads; client has not yet PUT the file
  // to the signed Storage URL. Worker doesn't act on these.
  'awaiting_upload',
  // Client called /finalize; worker extraction job is enqueued / running.
  'pending',
  'running',
  'succeeded',
  'failed',
]);

// URL-source extraction lifecycle. Distinct from upload extraction:
// URLs don't have a client-upload step (server fetches the URL itself),
// so there's no 'awaiting_upload' state. Inserted rows go straight to
// 'pending' for the worker to pick up.
export const urlSourceExtractionStatusEnum = pgEnum('url_source_extraction_status', [
  'pending',
  'running',
  'succeeded',
  'failed',
]);

// URL source kind — discriminator for fetch + extraction dispatch.
// Determined by the worker after fetch (content-type + URL pattern);
// rows insert with whatever default the controller picked and get
// updated to the resolved kind once `fetch_url` runs. Drives prompt
// shape (different content kinds get different fan-out treatment) +
// UX rendering (icon + label in Storage tile).
//
// v0.3.0: 'web_article' (HTML via Readability), 'pdf' (via pdf-parse),
// 'reddit_thread' (via Reddit's public .json API). Future kinds —
// 'youtube_video', 'twitter_thread', 'podcast_episode', 'rss_item' —
// in backlog; add enum values as those land.
export const urlSourceKindEnum = pgEnum('url_source_kind', ['web_article', 'pdf', 'reddit_thread']);
