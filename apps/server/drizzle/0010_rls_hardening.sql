-- Slice 9: RLS hardening — close the gaps from todos.md §3 RLS draft.
--
-- Existing policies (from earlier migrations):
--   - wiki_pages, wiki_sections (SELECT/UPDATE/DELETE on own user-scope)
--   - agent_tasks, research_outputs, research_output_sources/ancestors (SELECT own)
--
-- Tables this migration covers:
--   - wiki_section_history / transcripts / urls / ancestors (SELECT via section parent)
--   - agents (SELECT own; persona_prompt + user_prompt_notes column-level locked)
--   - call_transcripts (SELECT own)
--   - wiki_log (SELECT own)
--   - tags, wiki_page_tags (full CRUD on own — user manages tags from UI)
--   - usage_events (SELECT own — cost-visibility V1+)
--   - user_settings (SELECT/UPDATE own)
--
-- All tables already have RLS enabled (from migration 0000); this migration
-- only ADDS policies. service_role keeps bypass via the bypassrls attribute,
-- so server-side worker + Nest paths are unaffected.

-- ── wiki_section_history ───────────────────────────────────────────────────
CREATE POLICY "wiki_section_history_select_own"
  ON "wiki_section_history"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "wiki_sections" s
      JOIN "wiki_pages" p ON p.id = s.page_id
      WHERE s.id = "wiki_section_history".section_id
        AND p.user_id = auth.uid()
        AND p.scope = 'user'
    )
  );--> statement-breakpoint

-- ── wiki_section_transcripts ───────────────────────────────────────────────
CREATE POLICY "wiki_section_transcripts_select_own"
  ON "wiki_section_transcripts"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "wiki_sections" s
      JOIN "wiki_pages" p ON p.id = s.page_id
      WHERE s.id = "wiki_section_transcripts".section_id
        AND p.user_id = auth.uid()
        AND p.scope = 'user'
    )
  );--> statement-breakpoint

-- ── wiki_section_urls ──────────────────────────────────────────────────────
CREATE POLICY "wiki_section_urls_select_own"
  ON "wiki_section_urls"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "wiki_sections" s
      JOIN "wiki_pages" p ON p.id = s.page_id
      WHERE s.id = "wiki_section_urls".section_id
        AND p.user_id = auth.uid()
        AND p.scope = 'user'
    )
  );--> statement-breakpoint

-- ── wiki_section_ancestors ─────────────────────────────────────────────────
CREATE POLICY "wiki_section_ancestors_select_own"
  ON "wiki_section_ancestors"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "wiki_sections" s
      JOIN "wiki_pages" p ON p.id = s.page_id
      WHERE s.id = "wiki_section_ancestors".section_id
        AND p.user_id = auth.uid()
        AND p.scope = 'user'
    )
  );--> statement-breakpoint

-- ── agents — SELECT own, columns persona_prompt + user_prompt_notes locked ─
-- Rationale: specs/agents-and-scope.md Invariant 3 says persona_prompt is
-- NEVER returned to the client. Column-level REVOKE on the authenticated
-- role enforces it server-side regardless of any future RLS policy mistake.
REVOKE SELECT (persona_prompt, user_prompt_notes) ON "agents" FROM authenticated;--> statement-breakpoint
GRANT SELECT (
  id, user_id, slug, name, voice, root_page_id, is_default, created_at, tombstoned_at
) ON "agents" TO authenticated;--> statement-breakpoint

CREATE POLICY "agents_select_own"
  ON "agents"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

-- ── call_transcripts ───────────────────────────────────────────────────────
CREATE POLICY "call_transcripts_select_own"
  ON "call_transcripts"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

-- ── wiki_log ───────────────────────────────────────────────────────────────
CREATE POLICY "wiki_log_select_own"
  ON "wiki_log"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

-- ── tags ───────────────────────────────────────────────────────────────────
CREATE POLICY "tags_select_own"
  ON "tags"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "tags_insert_own"
  ON "tags"
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "tags_update_own"
  ON "tags"
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "tags_delete_own"
  ON "tags"
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

-- ── wiki_page_tags ─────────────────────────────────────────────────────────
CREATE POLICY "wiki_page_tags_select_own"
  ON "wiki_page_tags"
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "wiki_pages" p
      WHERE p.id = "wiki_page_tags".page_id
        AND p.user_id = auth.uid()
        AND p.scope = 'user'
    )
  );--> statement-breakpoint

CREATE POLICY "wiki_page_tags_insert_own"
  ON "wiki_page_tags"
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "wiki_pages" p
      WHERE p.id = "wiki_page_tags".page_id
        AND p.user_id = auth.uid()
        AND p.scope = 'user'
    )
  );--> statement-breakpoint

CREATE POLICY "wiki_page_tags_delete_own"
  ON "wiki_page_tags"
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM "wiki_pages" p
      WHERE p.id = "wiki_page_tags".page_id
        AND p.user_id = auth.uid()
        AND p.scope = 'user'
    )
  );--> statement-breakpoint

-- ── usage_events ───────────────────────────────────────────────────────────
CREATE POLICY "usage_events_select_own"
  ON "usage_events"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

-- ── user_settings ──────────────────────────────────────────────────────────
CREATE POLICY "user_settings_select_own"
  ON "user_settings"
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "user_settings_update_own"
  ON "user_settings"
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
