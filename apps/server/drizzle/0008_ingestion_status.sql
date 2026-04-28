-- Slice 6.5: ingestion_status on call_transcripts.
--
-- Worker writes 'running' at ingestion start, 'succeeded' / 'failed' at
-- terminal state. Server uses this for retry visibility + UI state.

CREATE TYPE "ingestion_status" AS ENUM ('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint

ALTER TABLE "call_transcripts"
  ADD COLUMN IF NOT EXISTS "ingestion_status" "ingestion_status" NOT NULL DEFAULT 'pending';--> statement-breakpoint

ALTER TABLE "call_transcripts"
  ADD COLUMN IF NOT EXISTS "ingestion_error" text;--> statement-breakpoint

-- Backfill existing rows: anything older with no ingestion attempt → 'succeeded'
-- (we have no signal that it failed, and they pre-date the column). Cancelled
-- calls stay 'pending' since they intentionally skip ingestion.
UPDATE "call_transcripts"
SET "ingestion_status" = 'succeeded'
WHERE "ingestion_status" = 'pending'
  AND "ended_at" IS NOT NULL
  AND "cancelled" = false;
