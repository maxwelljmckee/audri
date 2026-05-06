CREATE TYPE "public"."ingestion_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "tombstoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD COLUMN "pro_fan_out_response" jsonb;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD COLUMN "ingestion_status" "ingestion_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD COLUMN "ingestion_error" text;--> statement-breakpoint
ALTER TABLE "research_outputs" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "research_outputs" ADD COLUMN "citations" jsonb DEFAULT '[]'::jsonb NOT NULL;