ALTER TYPE "public"."agent_task_kind" ADD VALUE 'brief_me';--> statement-breakpoint
ALTER TYPE "public"."agent_task_kind" ADD VALUE 'recap';--> statement-breakpoint
ALTER TYPE "public"."agent_task_kind" ADD VALUE 'stalled_work';--> statement-breakpoint
ALTER TYPE "public"."agent_task_kind" ADD VALUE 'dreaming';--> statement-breakpoint
ALTER TYPE "public"."agent_task_kind" ADD VALUE 'todo_reminder';--> statement-breakpoint
ALTER TABLE "recurring_agent_tasks" ADD COLUMN "trigger_mode" text DEFAULT 'cron' NOT NULL;