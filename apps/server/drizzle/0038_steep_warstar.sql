-- v0.4.0 customization framework substrate.
--
-- Lands four coupled changes (see specs/customization-framework.md):
--
--   1. agent_type enum + agents.type column — immutable classification of
--      agent kind, referenced by KnobSpec.applies_to so renaming an agent
--      doesn't break knob bindings. Backfilled to 'live' for existing rows.
--
--   2. user_agent_settings table — per-(user, agent) typed knob overrides
--      stored as a single JSONB blob keyed by knob_name. Defaults live in
--      plugin-registry KnobSpec; this table only stores user overrides.
--
--   3. user_custom_rules table — natural-language rules scoped (app/agent
--      /page/plugin) for the NL overlay layer. CHECK constraints enforce
--      scope→FK shape.
--
--   4. Drop wiki_pages.agent_notes — superseded by user_custom_rules rows
--      scoped='page'. Per LD11 in the spec, the 1-day-old column is
--      clobbered (no data preservation; blast radius one user).
--
--   5. Seed Rumi (type='ingestion') agent row for each existing user.
--      The signup flow handles future users.
--
-- RLS policies + CHECK constraints below. Realtime publication enrollment
-- is intentionally skipped — both new tables are read server-side at
-- inference time; the Notes Settings UI will fetch on demand.

-- ── Enums ─────────────────────────────────────────────────────────────────
CREATE TYPE "public"."agent_type" AS ENUM('live', 'ingestion');--> statement-breakpoint
CREATE TYPE "public"."custom_rule_scope" AS ENUM('app', 'agent', 'page', 'plugin');--> statement-breakpoint
CREATE TYPE "public"."custom_rule_source" AS ENUM('user_set', 'dreams_proposed');--> statement-breakpoint

-- ── user_agent_settings ───────────────────────────────────────────────────
CREATE TABLE "user_agent_settings" (
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_agent_settings_user_id_agent_id_pk" PRIMARY KEY("user_id","agent_id")
);
--> statement-breakpoint

ALTER TABLE "user_agent_settings" ADD CONSTRAINT "user_agent_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_agent_settings" ADD CONSTRAINT "user_agent_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── user_custom_rules ─────────────────────────────────────────────────────
CREATE TABLE "user_custom_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" "custom_rule_scope" NOT NULL,
	"agent_id" uuid,
	"wiki_page_id" uuid,
	"plugin_id" text,
	"content" text NOT NULL,
	"source" "custom_rule_source" DEFAULT 'user_set' NOT NULL,
	"dream_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "user_custom_rules" ADD CONSTRAINT "user_custom_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_custom_rules" ADD CONSTRAINT "user_custom_rules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_custom_rules" ADD CONSTRAINT "user_custom_rules_wiki_page_id_wiki_pages_id_fk" FOREIGN KEY ("wiki_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- CHECK constraints enforcing scope→FK shape. Each scope value requires the
-- matching FK to be NON-NULL and the other FKs to be NULL. Plugin scope is
-- reserved (no FK; plugin_id is a text key into the code-side registry).
ALTER TABLE "user_custom_rules" ADD CONSTRAINT "user_custom_rules_scope_fk_shape"
	CHECK (
		(scope = 'app'    AND agent_id IS NULL     AND wiki_page_id IS NULL     AND plugin_id IS NULL) OR
		(scope = 'agent'  AND agent_id IS NOT NULL AND wiki_page_id IS NULL     AND plugin_id IS NULL) OR
		(scope = 'page'   AND agent_id IS NULL     AND wiki_page_id IS NOT NULL AND plugin_id IS NULL) OR
		(scope = 'plugin' AND agent_id IS NULL     AND wiki_page_id IS NULL     AND plugin_id IS NOT NULL)
	);--> statement-breakpoint

-- Source-FK coherence: dream_id is only meaningful when source='dreams_proposed'.
ALTER TABLE "user_custom_rules" ADD CONSTRAINT "user_custom_rules_source_dream_shape"
	CHECK (
		(source = 'user_set'         AND dream_id IS NULL) OR
		(source = 'dreams_proposed'  AND dream_id IS NOT NULL)
	);--> statement-breakpoint

CREATE INDEX "user_custom_rules_user_scope_active_idx" ON "user_custom_rules" USING btree ("user_id","scope","is_active");--> statement-breakpoint
CREATE INDEX "user_custom_rules_user_agent_active_idx" ON "user_custom_rules" USING btree ("user_id","agent_id","is_active") WHERE scope = 'agent' AND is_active = true;--> statement-breakpoint
CREATE INDEX "user_custom_rules_page_active_idx" ON "user_custom_rules" USING btree ("wiki_page_id","is_active") WHERE scope = 'page' AND is_active = true;--> statement-breakpoint

-- ── agents.type column ────────────────────────────────────────────────────
-- Add nullable first, backfill existing rows, then enforce NOT NULL.
ALTER TABLE "agents" ADD COLUMN "type" "agent_type";--> statement-breakpoint
UPDATE "agents" SET "type" = 'live' WHERE "type" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "type" SET NOT NULL;--> statement-breakpoint

CREATE INDEX "agents_user_type_idx" ON "agents" USING btree ("user_id","type");--> statement-breakpoint

-- ── Seed Rumi (type='ingestion') agent row per user ───────────────────────
-- For each existing user with at least one live agent (i.e. an active
-- account), seed an ingestion agent row. Idempotent: skip users that
-- already have a type='ingestion' agent.
--
-- The persona_prompt field is set to a placeholder noting that Rumi's
-- operating prompt lives in apps/worker/src/ingestion/pro-fan-out.ts —
-- moving the prompt into this column is deferred to the Track A prompt
-- decomposition work (see spec § "Ingestion-prompt-storage decision
-- deferred"). Voice is set to 'aoede' as a placeholder; ingestion agents
-- never play TTS so the value is unread at runtime.
INSERT INTO "agents" ("user_id", "type", "slug", "name", "voice", "persona_prompt", "is_default")
SELECT
	a."user_id",
	'ingestion'::"agent_type",
	'rumi',
	'Rumi',
	'aoede',
	'You are Rumi, the ingestion agent. You translate user voice notes into wiki content. Your operating prompt lives in apps/worker/src/ingestion/pro-fan-out.ts; this field is reserved for future per-user persona customization (see specs/customization-framework.md).',
	false
FROM "agents" a
WHERE a."type" = 'live'
GROUP BY a."user_id"
ON CONFLICT ("user_id", "slug") DO NOTHING;--> statement-breakpoint

-- ── Drop wiki_pages.agent_notes ───────────────────────────────────────────
ALTER TABLE "wiki_pages" DROP COLUMN "agent_notes";--> statement-breakpoint

-- ── RLS — user_agent_settings ────────────────────────────────────────────
ALTER TABLE "user_agent_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "user_agent_settings_select_own"
	ON "user_agent_settings"
	FOR SELECT
	TO authenticated
	USING (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "user_agent_settings_insert_own"
	ON "user_agent_settings"
	FOR INSERT
	TO authenticated
	WITH CHECK (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "user_agent_settings_update_own"
	ON "user_agent_settings"
	FOR UPDATE
	TO authenticated
	USING (user_id = auth.uid())
	WITH CHECK (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "user_agent_settings_delete_own"
	ON "user_agent_settings"
	FOR DELETE
	TO authenticated
	USING (user_id = auth.uid());--> statement-breakpoint

-- ── RLS — user_custom_rules ──────────────────────────────────────────────
ALTER TABLE "user_custom_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "user_custom_rules_select_own"
	ON "user_custom_rules"
	FOR SELECT
	TO authenticated
	USING (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "user_custom_rules_insert_own"
	ON "user_custom_rules"
	FOR INSERT
	TO authenticated
	WITH CHECK (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "user_custom_rules_update_own"
	ON "user_custom_rules"
	FOR UPDATE
	TO authenticated
	USING (user_id = auth.uid())
	WITH CHECK (user_id = auth.uid());--> statement-breakpoint

CREATE POLICY "user_custom_rules_delete_own"
	ON "user_custom_rules"
	FOR DELETE
	TO authenticated
	USING (user_id = auth.uid());
