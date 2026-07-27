CREATE TYPE "public"."script_source" AS ENUM('generated', 'user_provided');--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "script_source" "script_source" DEFAULT 'generated' NOT NULL;