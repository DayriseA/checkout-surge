CREATE TYPE "public"."order_failure_category" AS ENUM('business_rejection', 'administrative');--> statement-breakpoint
CREATE TYPE "public"."order_waiting_reason" AS ENUM('local_admission', 'erp_capacity', 'erp_unavailable', 'uncertain_result', 'intervention_required');--> statement-breakpoint
CREATE TABLE "erp_dispatch_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"processing_generation" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"public_order_id" text NOT NULL,
	"reservation_id" uuid NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"run_id" uuid,
	"quantity" integer NOT NULL,
	"correlation_id" text NOT NULL,
	"dispatched_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erp_dispatch_calls_quantity_positive" CHECK ("erp_dispatch_calls"."quantity" > 0),
	CONSTRAINT "erp_dispatch_calls_generation_nonnegative" CHECK ("erp_dispatch_calls"."processing_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "erp_scope_resilience_state" (
	"scope" text PRIMARY KEY NOT NULL,
	"cooldown_expires_at" timestamp with time zone,
	"circuit_open_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_runs" ADD COLUMN "administrative_stop" jsonb;--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD COLUMN "erp_call_id" uuid;--> statement-breakpoint
DROP INDEX "erp_attempts_order_delivery_attempt_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempts_order_delivery_attempt_unique" ON "erp_attempts" USING btree ("order_id","delivery_id","attempt_number") WHERE "erp_attempts"."erp_call_id" is null;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD COLUMN "processing_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD COLUMN "waiting_reason" "order_waiting_reason";--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD COLUMN "publication_owner" text;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD COLUMN "intervention_reason" text;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD COLUMN "unresolved_erp_call_id" uuid;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD COLUMN "attempt_counts" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "failure_category" "order_failure_category";--> statement-breakpoint
ALTER TABLE "erp_dispatch_calls" ADD CONSTRAINT "erp_dispatch_calls_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_dispatch_calls" ADD CONSTRAINT "erp_dispatch_calls_order_correlation_fk" FOREIGN KEY ("order_id","correlation_id") REFERENCES "public"."orders"("id","correlation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erp_dispatch_calls_order_id_idx" ON "erp_dispatch_calls" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "erp_dispatch_calls_run_id_idx" ON "erp_dispatch_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "erp_dispatch_calls_idempotency_key_idx" ON "erp_dispatch_calls" USING btree ("idempotency_key");--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD CONSTRAINT "erp_attempts_erp_call_id_erp_dispatch_calls_id_fk" FOREIGN KEY ("erp_call_id") REFERENCES "public"."erp_dispatch_calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD CONSTRAINT "order_recovery_jobs_unresolved_erp_call_fk" FOREIGN KEY ("unresolved_erp_call_id") REFERENCES "public"."erp_dispatch_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempts_erp_call_id_unique" ON "erp_attempts" USING btree ("erp_call_id");--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD CONSTRAINT "order_recovery_jobs_generation_nonnegative" CHECK ("order_recovery_jobs"."processing_generation" >= 0);
