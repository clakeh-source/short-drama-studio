ALTER TABLE "usage_log" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_log_idempotency_key_idx" ON "usage_log" USING btree ("idempotency_key");