ALTER TABLE "episodes" ADD COLUMN "script_text" text;--> statement-breakpoint
ALTER TABLE "shots" ADD COLUMN "unmatched_characters" text[] DEFAULT '{}'::text[] NOT NULL;