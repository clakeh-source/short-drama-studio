CREATE TABLE "character_reference_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"order_index" integer NOT NULL,
	"is_canonical" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_reference_images_path_uq" UNIQUE("character_id","storage_path"),
	CONSTRAINT "character_reference_images_order_bounds" CHECK (order_index between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "character_reference_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "character_reference_images" ADD CONSTRAINT "character_reference_images_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_reference_images_character_order_idx" ON "character_reference_images" USING btree ("character_id","order_index");--> statement-breakpoint
CREATE INDEX "character_reference_images_canonical_idx" ON "character_reference_images" USING btree ("character_id") WHERE is_canonical;--> statement-breakpoint
CREATE POLICY "character_reference_images_owner_all" ON "character_reference_images" AS PERMISSIVE FOR ALL TO "authenticated" USING (exists (select 1 from characters c join series s on s.id = c.series_id where c.id = character_reference_images.character_id and s.user_id = (select auth.uid()))) WITH CHECK (exists (select 1 from characters c join series s on s.id = c.series_id where c.id = character_reference_images.character_id and s.user_id = (select auth.uid())));