CREATE TYPE "public"."run_stage" AS ENUM('bible', 'cast', 'script', 'storyboard', 'shots', 'assemble', 'done');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'awaiting_gate', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"series_id" uuid,
	"prompt" text NOT NULL,
	"target_seconds" integer DEFAULT 180 NOT NULL,
	"stage" "run_stage" DEFAULT 'bible' NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"gate_expires_at" timestamp with time zone,
	"estimate_cents" integer DEFAULT 0 NOT NULL,
	"spent_cents" integer DEFAULT 0 NOT NULL,
	"error" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_user_created_idx" ON "runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_series_id_idx" ON "runs" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE POLICY "runs_owner_all" ON "runs" AS PERMISSIVE FOR ALL TO "authenticated" USING (runs.user_id = (select auth.uid())) WITH CHECK (runs.user_id = (select auth.uid()));