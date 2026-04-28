-- Slice 7: denormalize citations onto research_outputs as JSONB.
--
-- Citations also live in the normalized research_output_sources table for
-- analytics + cross-research lookups. But for the mobile detail view we need
-- them inline with the row so we don't have to ship a second RxDB collection
-- just to render footnotes. Write-time duplication; read-time win.

ALTER TABLE "research_outputs"
  ADD COLUMN IF NOT EXISTS "citations" jsonb NOT NULL DEFAULT '[]'::jsonb;
