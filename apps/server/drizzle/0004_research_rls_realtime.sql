-- Slice 7: research_outputs client-readability + realtime sync.
--
-- Clients only need to READ research_outputs (handler writes them server-side
-- via service_role; updates aren't a thing — research is immutable per
-- specs/research-task-prompt.md). Sources + ancestors are also read-only —
-- they're cited via the findings JSON, but explicit per-row reads are kept
-- available for the detail view should it want them.
--
-- agent_tasks stays server-only at MVP — the demo path is "fire-and-forget;
-- new research_outputs row appears via realtime sync." V1+ may expose
-- agent_tasks to the client for in-flight "research running…" UI.

-- ── _deleted GENERATED column for rxdb-supabase ────────────────────────────
ALTER TABLE "research_outputs"
  ADD COLUMN IF NOT EXISTS "_deleted" boolean
  GENERATED ALWAYS AS (tombstoned_at IS NOT NULL) STORED;--> statement-breakpoint

-- ── research_outputs RLS ───────────────────────────────────────────────────
ALTER TABLE "research_outputs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "research_outputs_select_own"
  ON "research_outputs"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

-- ── research_output_sources RLS ────────────────────────────────────────────
ALTER TABLE "research_output_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "research_output_sources_select_own"
  ON "research_output_sources"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "research_outputs" o
      WHERE o.id = "research_output_sources".research_output_id
        AND o.user_id = auth.uid()
    )
  );--> statement-breakpoint

-- ── research_output_ancestors RLS ──────────────────────────────────────────
ALTER TABLE "research_output_ancestors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "research_output_ancestors_select_own"
  ON "research_output_ancestors"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "research_outputs" o
      WHERE o.id = "research_output_ancestors".research_output_id
        AND o.user_id = auth.uid()
    )
  );--> statement-breakpoint

-- ── Realtime publication enrollment ────────────────────────────────────────
ALTER TABLE "research_outputs" REPLICA IDENTITY FULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'research_outputs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.research_outputs';
  END IF;
END $$;
