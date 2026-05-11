ALTER TABLE "user_settings" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "monthly_spend_limit_cents" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "monthly_spend_warning_threshold" real DEFAULT 0.8 NOT NULL;