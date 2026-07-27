CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"suburb" text DEFAULT '' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"postcode" text DEFAULT '' NOT NULL,
	"listing_type" text DEFAULT 'FOR SALE' NOT NULL,
	"bedrooms" integer DEFAULT 0 NOT NULL,
	"bathrooms" integer DEFAULT 0 NOT NULL,
	"carports" integer DEFAULT 0 NOT NULL,
	"images" text[] DEFAULT '{}'::text[] NOT NULL,
	"agent_name" text DEFAULT '' NOT NULL,
	"agent_email" text DEFAULT '' NOT NULL,
	"agent_picture" text DEFAULT '' NOT NULL,
	"agency_logo" text DEFAULT '' NOT NULL,
	"shotstack_render_id" text,
	"video_url" text,
	"rendered_at" timestamp with time zone,
	"render_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "listings_user_id_idx" ON "listings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "listings_user_rendered_idx" ON "listings" USING btree ("user_id","rendered_at");--> statement-breakpoint
CREATE POLICY "listings_owner_all" ON "listings" AS PERMISSIVE FOR ALL TO "authenticated" USING (listings.user_id = (select auth.uid())) WITH CHECK (listings.user_id = (select auth.uid()));