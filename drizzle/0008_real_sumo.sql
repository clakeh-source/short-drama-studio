ALTER TABLE "assets" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "shots" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "assets_shot_version_idx" ON "assets" USING btree ("shot_id","kind","version");