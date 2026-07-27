CREATE TYPE "public"."asset_kind" AS ENUM('video', 'image', 'voice', 'music', 'sfx');--> statement-breakpoint
CREATE TYPE "public"."episode_status" AS ENUM('draft', 'scripted', 'storyboarded', 'generating', 'rendered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'queued', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."series_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."shot_status" AS ENUM('pending', 'queued', 'generating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shot_id" uuid,
	"episode_id" uuid NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"provider" text NOT NULL,
	"provider_job_id" text,
	"storage_path" text,
	"duration_seconds" integer,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"appearance_prompt" text DEFAULT '' NOT NULL,
	"voice_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "characters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"synopsis" text DEFAULT '' NOT NULL,
	"hook" text,
	"cliffhanger" text,
	"script" jsonb,
	"status" "episode_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "episodes_series_number_uq" UNIQUE("series_id","number")
);
--> statement-breakpoint
ALTER TABLE "episodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "renders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_job_id" text,
	"storage_path" text,
	"duration_seconds" integer,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "renders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"time_of_day" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scenes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"logline" text DEFAULT '' NOT NULL,
	"genre" text DEFAULT '' NOT NULL,
	"tone" text DEFAULT '' NOT NULL,
	"audience" text DEFAULT '' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"episode_target_count" integer DEFAULT 1 NOT NULL,
	"episode_target_seconds" integer DEFAULT 60 NOT NULL,
	"bible" jsonb,
	"status" "series_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scene_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"duration_seconds" integer DEFAULT 5 NOT NULL,
	"camera" text DEFAULT 'medium' NOT NULL,
	"action" text DEFAULT '' NOT NULL,
	"dialogue" text,
	"speaker_character_id" uuid,
	"character_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"image_prompt" text,
	"video_prompt" text,
	"negative_prompt" text,
	"prompt_override" text,
	"status" "shot_status" DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "usage_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"series_id" uuid,
	"episode_id" uuid,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_shot_id_shots_id_fk" FOREIGN KEY ("shot_id") REFERENCES "public"."shots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episodes" ADD CONSTRAINT "episodes_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renders" ADD CONSTRAINT "renders_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_speaker_character_id_characters_id_fk" FOREIGN KEY ("speaker_character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_log" ADD CONSTRAINT "usage_log_episode_id_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."episodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_shot_id_idx" ON "assets" USING btree ("shot_id");--> statement-breakpoint
CREATE INDEX "assets_episode_id_idx" ON "assets" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "characters_series_id_idx" ON "characters" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "episodes_series_id_idx" ON "episodes" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "renders_episode_id_idx" ON "renders" USING btree ("episode_id");--> statement-breakpoint
CREATE INDEX "scenes_episode_id_order_idx" ON "scenes" USING btree ("episode_id","order_index");--> statement-breakpoint
CREATE INDEX "series_user_id_idx" ON "series" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "shots_scene_id_order_idx" ON "shots" USING btree ("scene_id","order_index");--> statement-breakpoint
CREATE INDEX "usage_log_user_created_idx" ON "usage_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE POLICY "assets_owner_all" ON "assets" AS PERMISSIVE FOR ALL TO "authenticated" USING (exists (select 1 from episodes e join series s on s.id = e.series_id where e.id = assets.episode_id and s.user_id = auth.uid())) WITH CHECK (exists (select 1 from episodes e join series s on s.id = e.series_id where e.id = assets.episode_id and s.user_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "characters_owner_all" ON "characters" AS PERMISSIVE FOR ALL TO "authenticated" USING (exists (select 1 from series s where s.id = characters.series_id and s.user_id = auth.uid())) WITH CHECK (exists (select 1 from series s where s.id = characters.series_id and s.user_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "episodes_owner_all" ON "episodes" AS PERMISSIVE FOR ALL TO "authenticated" USING (exists (select 1 from series s where s.id = episodes.series_id and s.user_id = auth.uid())) WITH CHECK (exists (select 1 from series s where s.id = episodes.series_id and s.user_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "renders_owner_all" ON "renders" AS PERMISSIVE FOR ALL TO "authenticated" USING (exists (select 1 from episodes e join series s on s.id = e.series_id where e.id = renders.episode_id and s.user_id = auth.uid())) WITH CHECK (exists (select 1 from episodes e join series s on s.id = e.series_id where e.id = renders.episode_id and s.user_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "scenes_owner_all" ON "scenes" AS PERMISSIVE FOR ALL TO "authenticated" USING (exists (select 1 from episodes e join series s on s.id = e.series_id where e.id = scenes.episode_id and s.user_id = auth.uid())) WITH CHECK (exists (select 1 from episodes e join series s on s.id = e.series_id where e.id = scenes.episode_id and s.user_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "series_owner_all" ON "series" AS PERMISSIVE FOR ALL TO "authenticated" USING (series.user_id = auth.uid()) WITH CHECK (series.user_id = auth.uid());--> statement-breakpoint
CREATE POLICY "shots_owner_all" ON "shots" AS PERMISSIVE FOR ALL TO "authenticated" USING (exists (select 1 from scenes sc join episodes e on e.id = sc.episode_id join series s on s.id = e.series_id where sc.id = shots.scene_id and s.user_id = auth.uid())) WITH CHECK (exists (select 1 from scenes sc join episodes e on e.id = sc.episode_id join series s on s.id = e.series_id where sc.id = shots.scene_id and s.user_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "usage_log_owner_all" ON "usage_log" AS PERMISSIVE FOR ALL TO "authenticated" USING (usage_log.user_id = auth.uid()) WITH CHECK (usage_log.user_id = auth.uid());