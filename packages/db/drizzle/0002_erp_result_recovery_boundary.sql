CREATE TYPE "recovery_job_status" AS ENUM ('pending', 'enqueued', 'escalated', 'resolved');
--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD COLUMN "confirmation_id" text;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD COLUMN "response" jsonb;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD COLUMN "delivery_id" text;
--> statement-breakpoint
UPDATE "erp_attempts" SET "delivery_id" = "order_id"::text WHERE "delivery_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ALTER COLUMN "delivery_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "erp_attempts_order_attempt_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempts_order_delivery_attempt_unique" ON "erp_attempts" USING btree ("order_id", "delivery_id", "attempt_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempts_success_idempotency_key_unique" ON "erp_attempts" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE TABLE "erp_confirmation_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" text NOT NULL,
  "order_id" text NOT NULL,
  "request_fingerprint" jsonb NOT NULL,
  "response" jsonb NOT NULL,
  "confirmation_id" text NOT NULL,
  "http_status" integer NOT NULL,
  "processed_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_confirmation_results_idempotency_key_unique" ON "erp_confirmation_results" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "erp_confirmation_results_created_at_idx" ON "erp_confirmation_results" USING btree ("created_at");
--> statement-breakpoint
CREATE TABLE "order_recovery_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recovery_key" text NOT NULL,
  "job_id" text NOT NULL,
  "source_job_id" text,
  "source_disposition" text,
  "order_id" uuid NOT NULL,
  "payload" jsonb NOT NULL,
  "result" jsonb,
  "reason" text NOT NULL,
  "status" "recovery_job_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_attempt_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "escalated_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "order_recovery_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_recovery_jobs_recovery_key_unique" ON "order_recovery_jobs" USING btree ("recovery_key");
--> statement-breakpoint
CREATE INDEX "order_recovery_jobs_status_next_attempt_idx" ON "order_recovery_jobs" USING btree ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX "order_recovery_jobs_order_id_idx" ON "order_recovery_jobs" USING btree ("order_id");
--> statement-breakpoint
CREATE TABLE "order_dead_letters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "job_id" text NOT NULL,
  "job_name" text NOT NULL,
  "claimed_order_id" text,
  "queue_name" text DEFAULT 'orders:process' NOT NULL,
  "payload" jsonb,
  "reason" text NOT NULL,
  "mismatched_fields" jsonb,
  "attempts_made" integer DEFAULT 0 NOT NULL,
  "correlation_id" text,
  "observed_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_dead_letters_queue_job_name_unique" ON "order_dead_letters" USING btree ("queue_name", "job_id", "job_name");
--> statement-breakpoint
CREATE INDEX "order_dead_letters_observed_at_idx" ON "order_dead_letters" USING btree ("observed_at");
