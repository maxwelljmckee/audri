CREATE TABLE "recurring_agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid,
	"kind" "agent_task_kind" NOT NULL,
	"suggested_id" text,
	"days_of_week" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"times" text[] DEFAULT '{}'::text[] NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"jitter_minutes" integer DEFAULT 30 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_agent_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_tasks" ALTER COLUMN "todo_page_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_agent_tasks" ADD CONSTRAINT "recurring_agent_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_agent_tasks" ADD CONSTRAINT "recurring_agent_tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_agent_tasks" ADD CONSTRAINT "recurring_agent_tasks_last_agent_task_id_agent_tasks_id_fk" FOREIGN KEY ("last_agent_task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_agent_tasks_user_active_idx" ON "recurring_agent_tasks" USING btree ("user_id") WHERE tombstoned_at IS NULL;--> statement-breakpoint
CREATE INDEX "recurring_agent_tasks_next_run_idx" ON "recurring_agent_tasks" USING btree ("next_run_at") WHERE next_run_at IS NOT NULL AND paused = false AND tombstoned_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_agent_tasks_user_suggested_unique" ON "recurring_agent_tasks" USING btree ("user_id","kind","suggested_id") WHERE suggested_id IS NOT NULL AND tombstoned_at IS NULL;