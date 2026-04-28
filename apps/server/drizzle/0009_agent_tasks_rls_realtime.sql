-- Slice 8: client-side visibility of agent_tasks for in-flight artifact UX.
--
-- The mobile app's plugin overlays show a "pending" placeholder row for any
-- agent_tasks(status in ('pending','running')) so users see queued work
-- instead of staring at an empty list while their research / podcast / etc.
-- is being generated. That requires syncing agent_tasks down to RxDB:
--   - RLS SELECT policy gating to own rows
--   - _deleted GENERATED column (rxdb-supabase tombstone signal)
--   - REPLICA IDENTITY FULL + supabase_realtime publication enrollment

-- ── _deleted GENERATED column. agent_tasks doesn't have tombstoned_at —
--    cancelled tasks stay in place with status='cancelled'; we never hard-
--    delete. Generate _deleted=false always so rxdb-supabase is happy.
ALTER TABLE "agent_tasks"
  ADD COLUMN IF NOT EXISTS "_deleted" boolean
  GENERATED ALWAYS AS (false) STORED;--> statement-breakpoint

-- ── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE "agent_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "agent_tasks_select_own"
  ON "agent_tasks"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

-- ── Realtime publication ──────────────────────────────────────────────────
ALTER TABLE "agent_tasks" REPLICA IDENTITY FULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'agent_tasks'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_tasks';
  END IF;
END $$;
