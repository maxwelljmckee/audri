-- Add cross-call retrieval tool kinds to usage_event_kind. Live Agent gets
-- search_transcripts + fetch_transcript tools in this tranche; recorded as
-- 0-cost usage_events for per-tool analytics symmetry with the wiki tools.
-- IF NOT EXISTS guards against re-runs after manual pre-application.
ALTER TYPE "public"."usage_event_kind" ADD VALUE IF NOT EXISTS 'tool_search_transcripts' BEFORE 'web_search';--> statement-breakpoint
ALTER TYPE "public"."usage_event_kind" ADD VALUE IF NOT EXISTS 'tool_fetch_transcript' BEFORE 'web_search';