-- Add 'zero_claims' to ingestion_status. Marks transcripts where the
-- pipeline ran cleanly but produced no writes (Flash dump, noteworthiness
-- gate, Pro emitted only skipped claims, or commit silently dropped a
-- malformed payload). Distinct from 'succeeded' so the UI can offer
-- manual retry on suspicion of a missed extraction.
--
-- IF NOT EXISTS guards against re-runs after manual pre-application
-- (same pattern as migration 0017).
ALTER TYPE "public"."ingestion_status" ADD VALUE IF NOT EXISTS 'zero_claims';