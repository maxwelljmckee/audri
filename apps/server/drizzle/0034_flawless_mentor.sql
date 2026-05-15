-- Add cross-call retrieval tool kinds to usage_event_kind. Live Agent gets
-- search_transcripts + fetch_transcript tools in this tranche; recorded as
-- 0-cost usage_events for per-tool analytics symmetry with the wiki tools.
--
-- Append-only (no BEFORE clause): drizzle-kit emitted `BEFORE 'web_search'`
-- to match schema declaration order, but pgEnum is a label set — runtime
-- ordering doesn't affect functionality. Append-only is also robust to
-- environments where `web_search` is missing from the deployed enum
-- (observed 2026-05-15 — likely a stale state from past DROP SCHEMA
-- recovery; flagged separately).
--
-- IF NOT EXISTS guards against re-runs after manual pre-application.
ALTER TYPE "public"."usage_event_kind" ADD VALUE IF NOT EXISTS 'tool_search_transcripts';--> statement-breakpoint
ALTER TYPE "public"."usage_event_kind" ADD VALUE IF NOT EXISTS 'tool_fetch_transcript';