CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."demo_preset_visibility" AS ENUM('public', 'admin');--> statement-breakpoint
CREATE TYPE "public"."demo_run_operator_mode" AS ENUM('public', 'admin');--> statement-breakpoint
CREATE TYPE "public"."demo_run_status" AS ENUM('starting', 'active', 'draining', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."demo_run_traffic_status" AS ENUM('not_started', 'starting', 'active', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."erp_attempt_status" AS ENUM('succeeded', 'failed', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."order_event_name" AS ENUM('reservation.secured', 'order.queued', 'order.processing', 'order.confirmed', 'order.failed', 'notification.recorded', 'inventory.updated', 'erp.attempt.failed', 'erp.attempt.succeeded');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('queued', 'processing', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."recovery_job_status" AS ENUM('pending', 'enqueued', 'escalated', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."reservation_pending_persistence_status" AS ENUM('pending_reconciliation', 'reconciled', 'exhausted');--> statement-breakpoint
CREATE TYPE "public"."sale_offer_purpose" AS ENUM('catalog', 'generated_run');--> statement-breakpoint
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
	"transport_attempt_counts" jsonb NOT NULL,
	"http_summary" jsonb NOT NULL,
	"traffic_outcome_summary" jsonb NOT NULL,
	"traffic_delivery_summary" jsonb NOT NULL,
	"http_timing_breakdown_summary" jsonb NOT NULL,
	"load_run_diagnostics_summary" jsonb NOT NULL,
	"completion_enrichment_status" "traffic_completion_enrichment_status" DEFAULT 'completed' NOT NULL,
	"traffic_summary_received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_run_sale_contexts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_run_sold_out_counts" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"latest_observed_at" timestamp with time zone,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_run_sold_out_counts_count_nonnegative" CHECK ("demo_run_sold_out_counts"."count" >= 0)
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
	"transport_attempt_counts" jsonb NOT NULL,
	"http_summary" jsonb NOT NULL,
	"traffic_delivery_summary" jsonb NOT NULL,
	"http_timing_breakdown_summary" jsonb NOT NULL,
	"load_run_diagnostics_summary" jsonb NOT NULL,
	"business_outcome_summary" jsonb NOT NULL,
	"terminal_inventory_snapshot" jsonb,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_run_summaries_terminal_status" CHECK ("demo_run_summaries"."status" IN ('completed', 'failed'))
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
	"status" "reservation_pending_persistence_status" DEFAULT 'pending_reconciliation' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"exhausted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_pending_persistence_attempt_count_nonnegative" CHECK ("reservation_pending_persistence"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"run_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"reservation_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"secured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_quantity_positive" CHECK ("reservations"."quantity" > 0)
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
	"recipient_placeholder" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_runs_id_sale_offer_id_unique" ON "demo_runs" USING btree ("id","sale_offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_sale_contexts_run_sale_offer_unique" ON "demo_run_sale_contexts" USING btree ("run_id","sale_offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_erp_attribution_identity_unique" ON "orders" USING btree ("id","correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_notification_attribution_identity_unique" ON "orders" USING btree ("id","sale_offer_id","correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_backing_order_identity_unique" ON "reservations" USING btree ("id","sale_offer_id","correlation_id","quantity");--> statement-breakpoint
ALTER TABLE "demo_run_finalizations" ADD CONSTRAINT "demo_run_finalizations_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_sale_contexts" ADD CONSTRAINT "demo_run_sale_contexts_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_sale_contexts" ADD CONSTRAINT "demo_run_sale_contexts_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_sale_contexts" ADD CONSTRAINT "demo_run_sale_contexts_run_sale_offer_demo_runs_fk" FOREIGN KEY ("run_id","sale_offer_id") REFERENCES "public"."demo_runs"("id","sale_offer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_sold_out_counts" ADD CONSTRAINT "demo_run_sold_out_counts_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_run_summaries" ADD CONSTRAINT "demo_run_summaries_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_runs" ADD CONSTRAINT "demo_runs_preset_id_demo_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."demo_presets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_runs" ADD CONSTRAINT "demo_runs_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD CONSTRAINT "erp_attempts_run_id_demo_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD CONSTRAINT "erp_attempts_order_correlation_fk" FOREIGN KEY ("order_id","correlation_id") REFERENCES "public"."orders"("id","correlation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_run_sale_context_fk" FOREIGN KEY ("run_id","sale_offer_id") REFERENCES "public"."demo_run_sale_contexts"("run_id","sale_offer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ADD CONSTRAINT "order_recovery_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_backing_reservation_fk" FOREIGN KEY ("reservation_id","sale_offer_id","correlation_id","quantity") REFERENCES "public"."reservations"("id","sale_offer_id","correlation_id","quantity") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_run_sale_context_fk" FOREIGN KEY ("run_id","sale_offer_id") REFERENCES "public"."demo_run_sale_contexts"("run_id","sale_offer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_pending_persistence" ADD CONSTRAINT "reservation_pending_persistence_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_pending_persistence" ADD CONSTRAINT "reservation_pending_persistence_run_sale_context_fk" FOREIGN KEY ("run_id","sale_offer_id") REFERENCES "public"."demo_run_sale_contexts"("run_id","sale_offer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_run_sale_context_fk" FOREIGN KEY ("run_id","sale_offer_id") REFERENCES "public"."demo_run_sale_contexts"("run_id","sale_offer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_offers" ADD CONSTRAINT "sale_offers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_notifications" ADD CONSTRAINT "simulated_notifications_sale_offer_id_sale_offers_id_fk" FOREIGN KEY ("sale_offer_id") REFERENCES "public"."sale_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_notifications" ADD CONSTRAINT "simulated_notifications_order_attribution_fk" FOREIGN KEY ("order_id","sale_offer_id","correlation_id") REFERENCES "public"."orders"("id","sale_offer_id","correlation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulated_notifications" ADD CONSTRAINT "simulated_notifications_run_sale_context_fk" FOREIGN KEY ("run_id","sale_offer_id") REFERENCES "public"."demo_run_sale_contexts"("run_id","sale_offer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_presets_slug_unique" ON "demo_presets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "demo_presets_visibility_idx" ON "demo_presets" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "demo_presets_archived_at_idx" ON "demo_presets" USING btree ("archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_finalizations_run_id_unique" ON "demo_run_finalizations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "demo_run_finalizations_run_id_idx" ON "demo_run_finalizations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_sale_contexts_sale_offer_id_unique" ON "demo_run_sale_contexts" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_summaries_run_id_unique" ON "demo_run_summaries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "demo_run_summaries_captured_at_idx" ON "demo_run_summaries" USING btree ("captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_runs_sale_offer_id_unique" ON "demo_runs" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE INDEX "demo_runs_preset_id_idx" ON "demo_runs" USING btree ("preset_id");--> statement-breakpoint
CREATE INDEX "demo_runs_status_idx" ON "demo_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempts_order_delivery_attempt_unique" ON "erp_attempts" USING btree ("order_id","delivery_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempts_success_idempotency_key_unique" ON "erp_attempts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "erp_attempts_order_id_idx" ON "erp_attempts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "erp_attempts_run_id_idx" ON "erp_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "erp_attempts_run_id_finished_at_created_at_idx" ON "erp_attempts" USING btree ("run_id","finished_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
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
CREATE INDEX "reservation_pending_persistence_run_id_idx" ON "reservation_pending_persistence" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_reservation_token_unique" ON "reservations" USING btree ("reservation_token");--> statement-breakpoint
CREATE INDEX "reservations_sale_offer_id_idx" ON "reservations" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE INDEX "reservations_run_id_idx" ON "reservations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "reservations_correlation_id_idx" ON "reservations" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "sale_offers_product_id_idx" ON "sale_offers" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sale_offers_purpose_idx" ON "sale_offers" USING btree ("purpose");--> statement-breakpoint
CREATE INDEX "sale_offers_active_window_idx" ON "sale_offers" USING btree ("is_active","sale_starts_at","sale_ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "simulated_notifications_order_id_unique" ON "simulated_notifications" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "simulated_notifications_order_id_idx" ON "simulated_notifications" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "simulated_notifications_sale_offer_id_idx" ON "simulated_notifications" USING btree ("sale_offer_id");--> statement-breakpoint
CREATE INDEX "simulated_notifications_run_id_idx" ON "simulated_notifications" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "simulated_notifications_run_id_recorded_at_created_at_idx" ON "simulated_notifications" USING btree ("run_id","recorded_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);
--> statement-breakpoint
-- A constant-expression partial unique index is the simplest durable guard
-- against concurrent direct writers creating more than one nonterminal run.
CREATE UNIQUE INDEX "demo_runs_single_non_terminal_idx"
ON "demo_runs" ((true))
WHERE "status" IN ('starting', 'active', 'draining');
