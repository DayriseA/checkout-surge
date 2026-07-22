CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."demo_preset_visibility" AS ENUM('public', 'admin');--> statement-breakpoint
CREATE TYPE "public"."demo_run_operator_mode" AS ENUM('public', 'admin');--> statement-breakpoint
CREATE TYPE "public"."demo_run_reservation_outcome" AS ENUM('api_sold_out_decision');--> statement-breakpoint
CREATE TYPE "public"."demo_run_reservation_outcome_source" AS ENUM('redis', 'postgres', 'api');--> statement-breakpoint
CREATE TYPE "public"."demo_run_status" AS ENUM('starting', 'active', 'draining', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."demo_run_traffic_status" AS ENUM('not_started', 'starting', 'active', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."erp_attempt_status" AS ENUM('succeeded', 'failed', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."order_event_name" AS ENUM('reservation.secured', 'reservation.rejected', 'reservation.released', 'reservation.expired', 'order.queued', 'order.processing', 'order.confirmed', 'order.failed', 'notification.recorded', 'inventory.updated', 'erp.attempt.failed', 'erp.attempt.succeeded');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('queued', 'processing', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."recovery_job_status" AS ENUM('pending', 'enqueued', 'escalated', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."reservation_pending_persistence_status" AS ENUM('pending_reconciliation', 'reconciled');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('secured', 'rejected', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."sale_offer_purpose" AS ENUM('catalog', 'generated_run');--> statement-breakpoint
CREATE TYPE "public"."simulated_notification_channel" AS ENUM('email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."simulated_notification_status" AS ENUM('recorded');--> statement-breakpoint
CREATE TYPE "public"."traffic_completion_enrichment_status" AS ENUM('pending', 'completed');--> statement-breakpoint
CREATE TABLE "demo_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"visibility" "demo_preset_visibility" NOT NULL,
	"is_editable" boolean DEFAULT false NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"display" jsonb NOT NULL,
	"traffic_config" jsonb NOT NULL,
	"inventory_config" jsonb NOT NULL,
	"erp_config" jsonb NOT NULL,
	"backpressure_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_presets_public_read_only" CHECK ("demo_presets"."visibility" <> 'public' OR "demo_presets"."is_editable" = false)
);
--> statement-breakpoint
CREATE TABLE "demo_run_finalizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"exit_code" integer,
	"error_message" text,
	"http_summary" jsonb NOT NULL,
	"traffic_outcome_summary" jsonb NOT NULL,
	"traffic_delivery_summary" jsonb NOT NULL,
	"http_timing_breakdown_summary" jsonb NOT NULL,
	"load_run_diagnostics_summary" jsonb NOT NULL,
	"api_request_lifecycle_summary" jsonb NOT NULL,
	"completion_enrichment_status" "traffic_completion_enrichment_status" DEFAULT 'completed' NOT NULL,
	"traffic_summary_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_run_reservation_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"outcome" "demo_run_reservation_outcome" NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"latest_observed_at" timestamp with time zone,
	"source" "demo_run_reservation_outcome_source" NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_run_reservation_outcomes_count_nonnegative" CHECK ("demo_run_reservation_outcomes"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "demo_run_sale_contexts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_run_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"preset_name" text NOT NULL,
	"status" "demo_run_status" NOT NULL,
	"failure_reason" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone NOT NULL,
	"http_summary" jsonb NOT NULL,
	"traffic_delivery_summary" jsonb NOT NULL,
	"http_timing_breakdown_summary" jsonb NOT NULL,
	"load_run_diagnostics_summary" jsonb NOT NULL,
	"api_request_lifecycle_summary" jsonb NOT NULL,
	"business_outcome_summary" jsonb NOT NULL,
	"terminal_inventory_snapshot" jsonb,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_run_summaries_terminal_status" CHECK ("demo_run_summaries"."status" IN ('completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "demo_run_teardown_receipts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"preset_name" text NOT NULL,
	"durable_deleted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preset_id" uuid NOT NULL,
	"preset_name" text NOT NULL,
	"operator_mode" "demo_run_operator_mode" NOT NULL,
	"status" "demo_run_status" DEFAULT 'starting' NOT NULL,
	"traffic_status" "demo_run_traffic_status" DEFAULT 'not_started' NOT NULL,
	"config_snapshot" jsonb NOT NULL,
	"sale_offer_id" uuid,
	"started_at" timestamp with time zone,
	"traffic_started_at" timestamp with time zone,
	"traffic_ended_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"run_id" uuid,
	"attempt_number" integer NOT NULL,
	"status" "erp_attempt_status" NOT NULL,
	"terminal" boolean DEFAULT false NOT NULL,
	"http_status" integer,
	"error_code" text,
	"error_message" text,
	"latency_ms" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"confirmation_id" text,
	"idempotency_key" text,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erp_attempts_attempt_number_positive" CHECK ("erp_attempts"."attempt_number" > 0),
	CONSTRAINT "erp_attempts_latency_nonnegative" CHECK ("erp_attempts"."latency_ms" >= 0),
	CONSTRAINT "erp_attempts_http_status_valid" CHECK ("erp_attempts"."http_status" IS NULL OR ("erp_attempts"."http_status" >= 100 AND "erp_attempts"."http_status" <= 599)),
	CONSTRAINT "erp_attempts_finished_after_started" CHECK ("erp_attempts"."finished_at" >= "erp_attempts"."started_at")
);
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
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"reservation_id" uuid,
	"sale_offer_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"run_id" uuid,
	"event_name" "order_event_name" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_order_id" text NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"run_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" "order_status" DEFAULT 'queued' NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"queued_at" timestamp with time zone NOT NULL,
	"processing_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_quantity_positive" CHECK ("orders"."quantity" > 0),
	CONSTRAINT "orders_confirmed_requires_confirmed_at" CHECK ("orders"."status" <> 'confirmed' OR "orders"."confirmed_at" IS NOT NULL),
	CONSTRAINT "orders_failed_requires_failed_at" CHECK ("orders"."status" <> 'failed' OR "orders"."failed_at" IS NOT NULL),
	CONSTRAINT "orders_in_progress_requires_processing_at" CHECK ("orders"."status" NOT IN ('processing', 'confirmed', 'failed') OR "orders"."processing_at" IS NOT NULL),
	CONSTRAINT "orders_terminal_timestamps_after_queued_at" CHECK (("orders"."confirmed_at" IS NULL OR "orders"."confirmed_at" >= "orders"."queued_at") AND ("orders"."failed_at" IS NULL OR "orders"."failed_at" >= "orders"."queued_at"))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_runtime_policies" (
	"id" text PRIMARY KEY DEFAULT 'active' NOT NULL,
	"policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_runtime_policies_active_singleton" CHECK ("public_runtime_policies"."id" = 'active')
);
--> statement-breakpoint
CREATE TABLE "reservation_pending_persistence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"run_id" uuid,
	"idempotency_key" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"reservation_token" text NOT NULL,
	"status" "reservation_pending_persistence_status" DEFAULT 'pending_reconciliation' NOT NULL,
	"secured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_pending_persistence_quantity_positive" CHECK ("reservation_pending_persistence"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"run_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" "reservation_status" NOT NULL,
	"reservation_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"secured_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_quantity_positive" CHECK ("reservations"."quantity" > 0),
	CONSTRAINT "reservations_released_requires_released_at" CHECK ("reservations"."status" <> 'released' OR "reservations"."released_at" IS NOT NULL),
	CONSTRAINT "reservations_expired_requires_expired_at" CHECK ("reservations"."status" <> 'expired' OR "reservations"."expired_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sale_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"allocated_stock" integer NOT NULL,
	"sale_starts_at" timestamp with time zone NOT NULL,
	"sale_ends_at" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"purpose" "sale_offer_purpose" DEFAULT 'catalog' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_offers_allocated_stock_nonnegative" CHECK ("sale_offers"."allocated_stock" >= 0),
	CONSTRAINT "sale_offers_valid_window" CHECK ("sale_offers"."sale_ends_at" > "sale_offers"."sale_starts_at")
);
--> statement-breakpoint
CREATE TABLE "simulated_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"run_id" uuid,
	"channel" "simulated_notification_channel" NOT NULL,
	"recipient_placeholder" text NOT NULL,
	"status" "simulated_notification_status" DEFAULT 'recorded' NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_runs_id_sale_offer_id_unique" ON "demo_runs" USING btree ("id","sale_offer_id");--> statement-breakpoint
ALTER TABLE "demo_run_finalizations" ADD CONSTRAINT "demo_run_finalizations_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_reservation_outcomes" ADD CONSTRAINT "demo_run_reservation_outcomes_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_sale_contexts" ADD CONSTRAINT "demo_run_sale_contexts_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_sale_contexts" ADD CONSTRAINT "demo_run_sale_contexts_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_sale_contexts" ADD CONSTRAINT "demo_run_sale_contexts_run_sale_offer_demo_runs_fk" FOREIGN KEY ("run_id","sale_offer_id") REFERENCES "public"."demo_runs"("id","sale_offer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_summaries" ADD CONSTRAINT "demo_run_summaries_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_runs" ADD CONSTRAINT "demo_runs_preset_id_demo_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."demo_presets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_runs" ADD CONSTRAINT "demo_runs_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD CONSTRAINT "erp_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD CONSTRAINT "erp_attempts_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD CONSTRAINT "order_recovery_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_pending_persistence" ADD CONSTRAINT "reservation_pending_persistence_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_pending_persistence" ADD CONSTRAINT "reservation_pending_persistence_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_offers" ADD CONSTRAINT "sale_offers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_notifications" ADD CONSTRAINT "simulated_notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_notifications" ADD CONSTRAINT "simulated_notifications_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_notifications" ADD CONSTRAINT "simulated_notifications_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_presets_slug_unique" ON "demo_presets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "demo_presets_visibility_idx" ON "demo_presets" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "demo_presets_archived_at_idx" ON "demo_presets" USING btree ("archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_finalizations_run_id_unique" ON "demo_run_finalizations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "demo_run_finalizations_run_id_idx" ON "demo_run_finalizations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_reservation_outcomes_run_outcome_unique" ON "demo_run_reservation_outcomes" USING btree ("run_id","outcome");--> statement-breakpoint
CREATE INDEX "demo_run_reservation_outcomes_run_id_idx" ON "demo_run_reservation_outcomes" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_sale_contexts_sale_offer_id_unique" ON "demo_run_sale_contexts" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_sale_contexts_run_sale_offer_unique" ON "demo_run_sale_contexts" USING btree ("run_id","sale_offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_summaries_run_id_unique" ON "demo_run_summaries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "demo_run_summaries_captured_at_idx" ON "demo_run_summaries" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "demo_run_teardown_receipts_sale_offer_id_idx" ON "demo_run_teardown_receipts" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_runs_sale_offer_id_unique" ON "demo_runs" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE INDEX "demo_runs_preset_id_idx" ON "demo_runs" USING btree ("preset_id");--> statement-breakpoint
CREATE INDEX "demo_runs_status_idx" ON "demo_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempts_order_delivery_attempt_unique" ON "erp_attempts" USING btree ("order_id","delivery_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempts_success_idempotency_key_unique" ON "erp_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "erp_attempts_order_id_idx" ON "erp_attempts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "erp_attempts_run_id_idx" ON "erp_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "erp_attempts_run_id_finished_at_created_at_idx" ON "erp_attempts" USING btree ("run_id","finished_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "erp_confirmation_results_idempotency_key_unique" ON "erp_confirmation_results" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "erp_confirmation_results_created_at_idx" ON "erp_confirmation_results" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_dead_letters_queue_job_name_unique" ON "order_dead_letters" USING btree ("queue_name","job_id","job_name");--> statement-breakpoint
CREATE INDEX "order_dead_letters_observed_at_idx" ON "order_dead_letters" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "order_events_order_id_idx" ON "order_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_events_reservation_id_idx" ON "order_events" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "order_events_sale_offer_id_idx" ON "order_events" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE INDEX "order_events_run_id_idx" ON "order_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "order_events_run_id_occurred_at_created_at_idx" ON "order_events" USING btree ("run_id","occurred_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "order_events_event_name_idx" ON "order_events" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "order_events_occurred_at_idx" ON "order_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_recovery_jobs_recovery_key_unique" ON "order_recovery_jobs" USING btree ("recovery_key");--> statement-breakpoint
CREATE INDEX "order_recovery_jobs_status_next_attempt_idx" ON "order_recovery_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "order_recovery_jobs_order_id_idx" ON "order_recovery_jobs" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_public_order_id_unique" ON "orders" USING btree ("public_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_reservation_id_unique" ON "orders" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "orders_sale_offer_id_idx" ON "orders" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE INDEX "orders_run_id_idx" ON "orders" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "orders_run_id_queued_at_created_at_idx" ON "orders" USING btree ("run_id","queued_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_correlation_id_idx" ON "orders" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_unique" ON "products" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_unique" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "products_is_active_idx" ON "products" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_pending_persistence_reservation_id_unique" ON "reservation_pending_persistence" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_pending_persistence_offer_idempotency_unique" ON "reservation_pending_persistence" USING btree ("sale_offer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "reservation_pending_persistence_sale_offer_id_idx" ON "reservation_pending_persistence" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE INDEX "reservation_pending_persistence_run_id_idx" ON "reservation_pending_persistence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "reservation_pending_persistence_status_idx" ON "reservation_pending_persistence" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_reservation_token_unique" ON "reservations" USING btree ("reservation_token");--> statement-breakpoint
CREATE INDEX "reservations_sale_offer_id_idx" ON "reservations" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE INDEX "reservations_run_id_idx" ON "reservations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "reservations_correlation_id_idx" ON "reservations" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "reservations_status_idx" ON "reservations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sale_offers_product_id_idx" ON "sale_offers" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sale_offers_purpose_idx" ON "sale_offers" USING btree ("purpose");--> statement-breakpoint
CREATE INDEX "sale_offers_active_window_idx" ON "sale_offers" USING btree ("is_active","sale_starts_at","sale_ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "simulated_notifications_order_channel_unique" ON "simulated_notifications" USING btree ("order_id","channel");--> statement-breakpoint
CREATE INDEX "simulated_notifications_order_id_idx" ON "simulated_notifications" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "simulated_notifications_sale_offer_id_idx" ON "simulated_notifications" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE INDEX "simulated_notifications_run_id_idx" ON "simulated_notifications" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "simulated_notifications_run_id_recorded_at_created_at_idx" ON "simulated_notifications" USING btree ("run_id","recorded_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);
--> statement-breakpoint
-- Drizzle snapshots do not represent this constant-expression partial index.
-- It is the cross-writer invariant admitting at most one non-terminal run.
CREATE UNIQUE INDEX "demo_runs_single_non_terminal_idx"
  ON "demo_runs" ((status IN ('starting', 'active', 'draining')))
  WHERE status IN ('starting', 'active', 'draining');
--> statement-breakpoint
-- The functions and triggers below are required final-state objects that are
-- also invisible to Drizzle snapshots.
CREATE FUNCTION "enforce_order_backing_secured_reservation"()
RETURNS trigger AS $$
DECLARE
  backing_reservation "reservations"%ROWTYPE;
BEGIN
  SELECT *
  INTO backing_reservation
  FROM "reservations"
  WHERE "id" = NEW."reservation_id"
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'orders.reservation_id % must reference an existing secured reservation', NEW."reservation_id"
      USING ERRCODE = '23514';
  END IF;

  IF backing_reservation."status" IS DISTINCT FROM 'secured'::"reservation_status"
    OR backing_reservation."sale_offer_id" IS DISTINCT FROM NEW."sale_offer_id"
    OR backing_reservation."run_id" IS DISTINCT FROM NEW."run_id"
    OR backing_reservation."correlation_id" IS DISTINCT FROM NEW."correlation_id"
    OR backing_reservation."quantity" IS DISTINCT FROM NEW."quantity" THEN
    RAISE EXCEPTION 'order % must match secured reservation %', NEW."id", NEW."reservation_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "orders_enforce_backing_secured_reservation"
BEFORE INSERT OR UPDATE ON "orders"
FOR EACH ROW EXECUTE FUNCTION "enforce_order_backing_secured_reservation"();
--> statement-breakpoint
CREATE FUNCTION "preserve_order_backing_secured_reservation"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "orders" AS existing_order
    WHERE existing_order."reservation_id" = NEW."id"
      AND (
        NEW."status" IS DISTINCT FROM 'secured'::"reservation_status"
        OR existing_order."sale_offer_id" IS DISTINCT FROM NEW."sale_offer_id"
        OR existing_order."run_id" IS DISTINCT FROM NEW."run_id"
        OR existing_order."correlation_id" IS DISTINCT FROM NEW."correlation_id"
        OR existing_order."quantity" IS DISTINCT FROM NEW."quantity"
      )
  ) THEN
    RAISE EXCEPTION 'reservation % cannot be changed because an order depends on its secured attribution', NEW."id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "reservations_preserve_order_backing_secured_reservation"
BEFORE UPDATE OF "status", "sale_offer_id", "run_id", "correlation_id", "quantity" ON "reservations"
FOR EACH ROW EXECUTE FUNCTION "preserve_order_backing_secured_reservation"();
--> statement-breakpoint
CREATE FUNCTION "enforce_erp_attempt_order_attribution"()
RETURNS trigger AS $$
DECLARE
  parent_order "orders"%ROWTYPE;
BEGIN
  SELECT * INTO parent_order FROM "orders" WHERE "id" = NEW."order_id" FOR UPDATE;

  IF NOT FOUND
    OR NEW."run_id" IS DISTINCT FROM parent_order."run_id"
    OR NEW."correlation_id" IS DISTINCT FROM parent_order."correlation_id" THEN
    RAISE EXCEPTION 'ERP attempt % must match order % attribution', NEW."id", NEW."order_id"
      USING ERRCODE = '23514', CONSTRAINT = 'erp_attempts_order_attribution_agreement';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "erp_attempts_enforce_order_attribution"
BEFORE INSERT OR UPDATE OF "order_id", "run_id", "correlation_id" ON "erp_attempts"
FOR EACH ROW EXECUTE FUNCTION "enforce_erp_attempt_order_attribution"();
--> statement-breakpoint
CREATE FUNCTION "enforce_order_event_parent_attribution"()
RETURNS trigger AS $$
DECLARE
  parent_order "orders"%ROWTYPE;
  parent_reservation "reservations"%ROWTYPE;
BEGIN
  IF NEW."order_id" IS NOT NULL THEN
    SELECT * INTO parent_order FROM "orders" WHERE "id" = NEW."order_id" FOR UPDATE;

    IF NOT FOUND
      OR NEW."reservation_id" IS DISTINCT FROM parent_order."reservation_id"
      OR NEW."sale_offer_id" IS DISTINCT FROM parent_order."sale_offer_id"
      OR NEW."run_id" IS DISTINCT FROM parent_order."run_id"
      OR NEW."correlation_id" IS DISTINCT FROM parent_order."correlation_id" THEN
      RAISE EXCEPTION 'order event % must match order % attribution', NEW."id", NEW."order_id"
        USING ERRCODE = '23514', CONSTRAINT = 'order_events_order_attribution_agreement';
    END IF;
  ELSIF NEW."reservation_id" IS NOT NULL THEN
    SELECT * INTO parent_reservation FROM "reservations" WHERE "id" = NEW."reservation_id" FOR UPDATE;

    IF NOT FOUND
      OR NEW."sale_offer_id" IS DISTINCT FROM parent_reservation."sale_offer_id"
      OR NEW."run_id" IS DISTINCT FROM parent_reservation."run_id"
      OR NEW."correlation_id" IS DISTINCT FROM parent_reservation."correlation_id" THEN
      RAISE EXCEPTION 'order event % must match reservation % attribution', NEW."id", NEW."reservation_id"
        USING ERRCODE = '23514', CONSTRAINT = 'order_events_reservation_attribution_agreement';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "order_events_enforce_parent_attribution"
BEFORE INSERT OR UPDATE OF "order_id", "reservation_id", "sale_offer_id", "run_id", "correlation_id" ON "order_events"
FOR EACH ROW EXECUTE FUNCTION "enforce_order_event_parent_attribution"();
--> statement-breakpoint
CREATE FUNCTION "preserve_order_child_attribution"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "erp_attempts" AS attempt
    WHERE attempt."order_id" = NEW."id"
      AND (attempt."run_id" IS DISTINCT FROM NEW."run_id"
        OR attempt."correlation_id" IS DISTINCT FROM NEW."correlation_id")
  ) OR EXISTS (
    SELECT 1 FROM "order_events" AS event
    WHERE event."order_id" = NEW."id"
      AND (event."reservation_id" IS DISTINCT FROM NEW."reservation_id"
        OR event."sale_offer_id" IS DISTINCT FROM NEW."sale_offer_id"
        OR event."run_id" IS DISTINCT FROM NEW."run_id"
        OR event."correlation_id" IS DISTINCT FROM NEW."correlation_id")
  ) THEN
    RAISE EXCEPTION 'order % attribution cannot invalidate existing ERP attempts or events', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'orders_child_attribution_preservation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "orders_preserve_child_attribution"
BEFORE UPDATE OF "reservation_id", "sale_offer_id", "run_id", "correlation_id" ON "orders"
FOR EACH ROW EXECUTE FUNCTION "preserve_order_child_attribution"();
--> statement-breakpoint
CREATE FUNCTION "preserve_reservation_only_event_attribution"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "order_events" AS event
    WHERE event."order_id" IS NULL
      AND event."reservation_id" = NEW."id"
      AND (event."sale_offer_id" IS DISTINCT FROM NEW."sale_offer_id"
        OR event."run_id" IS DISTINCT FROM NEW."run_id"
        OR event."correlation_id" IS DISTINCT FROM NEW."correlation_id")
  ) THEN
    RAISE EXCEPTION 'reservation % attribution cannot invalidate existing reservation-only events', NEW."id"
      USING ERRCODE = '23514', CONSTRAINT = 'reservations_event_attribution_preservation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "reservations_preserve_event_attribution"
BEFORE UPDATE OF "sale_offer_id", "run_id", "correlation_id" ON "reservations"
FOR EACH ROW EXECUTE FUNCTION "preserve_reservation_only_event_attribution"();
--> statement-breakpoint
CREATE FUNCTION "set_updated_at"()
RETURNS trigger AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "products_set_updated_at"
BEFORE UPDATE ON "products"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "sale_offers_set_updated_at"
BEFORE UPDATE ON "sale_offers"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "demo_presets_set_updated_at"
BEFORE UPDATE ON "demo_presets"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "demo_runs_set_updated_at"
BEFORE UPDATE ON "demo_runs"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "demo_run_sale_contexts_set_updated_at"
BEFORE UPDATE ON "demo_run_sale_contexts"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "reservations_set_updated_at"
BEFORE UPDATE ON "reservations"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "orders_set_updated_at"
BEFORE UPDATE ON "orders"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "reservation_pending_persistence_set_updated_at"
BEFORE UPDATE ON "reservation_pending_persistence"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "demo_run_finalizations_set_updated_at"
BEFORE UPDATE ON "demo_run_finalizations"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE TRIGGER "public_runtime_policies_set_updated_at"
BEFORE UPDATE ON "public_runtime_policies"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
CREATE FUNCTION "enforce_demo_run_sale_context_offer_purpose"()
RETURNS trigger AS $$
DECLARE
  offer_purpose "sale_offer_purpose";
BEGIN
  SELECT "purpose"
  INTO offer_purpose
  FROM "sale_offers"
  WHERE "id" = NEW."sale_offer_id";

  IF offer_purpose IS DISTINCT FROM 'generated_run'::"sale_offer_purpose" THEN
    RAISE EXCEPTION 'demo_run_sale_contexts.sale_offer_id % must reference a generated_run sale offer', NEW."sale_offer_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "demo_run_sale_contexts_enforce_offer_purpose"
BEFORE INSERT OR UPDATE OF "sale_offer_id" ON "demo_run_sale_contexts"
FOR EACH ROW EXECUTE FUNCTION "enforce_demo_run_sale_context_offer_purpose"();
--> statement-breakpoint
CREATE FUNCTION "enforce_run_owned_sale_offer_attribution"()
RETURNS trigger AS $$
DECLARE
  offer_purpose "sale_offer_purpose";
  owner_run_id uuid;
BEGIN
  SELECT "purpose"
  INTO offer_purpose
  FROM "sale_offers"
  WHERE "id" = NEW."sale_offer_id";

  IF offer_purpose IS NULL THEN
    RETURN NEW;
  END IF;

  IF offer_purpose = 'generated_run'::"sale_offer_purpose" THEN
    SELECT "run_id"
    INTO owner_run_id
    FROM "demo_run_sale_contexts"
    WHERE "sale_offer_id" = NEW."sale_offer_id";

    IF owner_run_id IS NULL THEN
      RAISE EXCEPTION 'generated_run sale offer % has no demo_run_sale_context', NEW."sale_offer_id"
        USING ERRCODE = '23514';
    END IF;

    IF NEW."run_id" IS NULL OR NEW."run_id" <> owner_run_id THEN
      RAISE EXCEPTION 'run-attributed row must use owning run %, got % for sale offer %', owner_run_id, NEW."run_id", NEW."sale_offer_id"
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."run_id" IS NOT NULL THEN
    RAISE EXCEPTION 'run-attributed rows must reference generated_run sale offers, got catalog sale offer %', NEW."sale_offer_id"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "reservations_enforce_run_owned_sale_offer_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "reservations"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
--> statement-breakpoint
CREATE TRIGGER "orders_enforce_run_owned_sale_offer_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "orders"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
--> statement-breakpoint
CREATE TRIGGER "rpp_enforce_run_sale_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "reservation_pending_persistence"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
--> statement-breakpoint
CREATE TRIGGER "order_events_enforce_run_owned_sale_offer_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "order_events"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
--> statement-breakpoint
CREATE TRIGGER "sim_notifications_enforce_run_sale_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "simulated_notifications"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
