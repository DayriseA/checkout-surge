CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TYPE "sale_offer_purpose" AS ENUM ('catalog', 'generated_run');
--> statement-breakpoint
CREATE TYPE "reservation_status" AS ENUM ('secured', 'rejected', 'released', 'expired');
--> statement-breakpoint
CREATE TYPE "order_status" AS ENUM ('queued', 'processing', 'confirmed', 'failed');
--> statement-breakpoint
CREATE TYPE "erp_attempt_status" AS ENUM ('succeeded', 'failed', 'timed_out');
--> statement-breakpoint
CREATE TYPE "order_event_name" AS ENUM (
  'reservation.secured',
  'reservation.rejected',
  'reservation.released',
  'reservation.expired',
  'order.queued',
  'order.processing',
  'order.confirmed',
  'order.failed',
  'notification.recorded',
  'inventory.updated',
  'erp.attempt.failed',
  'erp.attempt.succeeded'
);
--> statement-breakpoint
CREATE TYPE "demo_preset_visibility" AS ENUM ('public', 'admin');
--> statement-breakpoint
CREATE TYPE "demo_run_operator_mode" AS ENUM ('public', 'admin');
--> statement-breakpoint
CREATE TYPE "demo_run_status" AS ENUM ('starting', 'active', 'draining', 'completed', 'failed');
--> statement-breakpoint
CREATE TYPE "demo_run_traffic_status" AS ENUM (
  'not_started',
  'starting',
  'active',
  'succeeded',
  'failed'
);
--> statement-breakpoint
CREATE TYPE "reservation_pending_persistence_status" AS ENUM (
  'pending_reconciliation',
  'reconciled'
);
--> statement-breakpoint
CREATE TYPE "simulated_notification_channel" AS ENUM ('email', 'sms');
--> statement-breakpoint
CREATE TYPE "simulated_notification_status" AS ENUM ('recorded');
--> statement-breakpoint
CREATE TYPE "demo_run_reservation_outcome" AS ENUM ('api_sold_out_decision');
--> statement-breakpoint
CREATE TYPE "demo_run_reservation_outcome_source" AS ENUM ('redis', 'postgres', 'api');
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
CREATE TABLE "sale_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "allocated_stock" integer NOT NULL,
  "sale_starts_at" timestamp with time zone NOT NULL,
  "sale_ends_at" timestamp with time zone NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "purpose" "sale_offer_purpose" DEFAULT 'catalog' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sale_offers_allocated_stock_nonnegative" CHECK ("allocated_stock" >= 0),
  CONSTRAINT "sale_offers_valid_window" CHECK ("sale_ends_at" > "sale_starts_at")
);
--> statement-breakpoint
CREATE TABLE "demo_presets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL,
  "visibility" "demo_preset_visibility" NOT NULL,
  "is_editable" boolean DEFAULT false NOT NULL,
  "is_custom" boolean DEFAULT false NOT NULL,
  "display" jsonb NOT NULL,
  "traffic_config" jsonb NOT NULL,
  "inventory_config" jsonb NOT NULL,
  "erp_config" jsonb NOT NULL,
  "backpressure_config" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_presets_public_read_only" CHECK ("visibility" <> 'public' OR "is_editable" = false)
);
--> statement-breakpoint
CREATE TABLE "demo_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "preset_id" uuid NOT NULL REFERENCES "demo_presets"("id") ON DELETE RESTRICT,
  "preset_name" text NOT NULL,
  "operator_mode" "demo_run_operator_mode" NOT NULL,
  "status" "demo_run_status" DEFAULT 'starting' NOT NULL,
  "traffic_status" "demo_run_traffic_status" DEFAULT 'not_started' NOT NULL,
  "config_snapshot" jsonb NOT NULL,
  "sale_offer_id" uuid REFERENCES "sale_offers"("id") ON DELETE RESTRICT,
  "started_at" timestamp with time zone,
  "traffic_started_at" timestamp with time zone,
  "traffic_ended_at" timestamp with time zone,
  "finalized_at" timestamp with time zone,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_run_sale_contexts" (
  "run_id" uuid PRIMARY KEY REFERENCES "demo_runs"("id") ON DELETE CASCADE,
  "sale_offer_id" uuid NOT NULL REFERENCES "sale_offers"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sale_offer_id" uuid NOT NULL REFERENCES "sale_offers"("id") ON DELETE RESTRICT,
  "correlation_id" text NOT NULL,
  "run_id" uuid REFERENCES "demo_runs"("id") ON DELETE RESTRICT,
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
  CONSTRAINT "reservations_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_order_id" text NOT NULL,
  "sale_offer_id" uuid NOT NULL REFERENCES "sale_offers"("id") ON DELETE RESTRICT,
  "reservation_id" uuid NOT NULL REFERENCES "reservations"("id") ON DELETE RESTRICT,
  "correlation_id" text NOT NULL,
  "run_id" uuid REFERENCES "demo_runs"("id") ON DELETE RESTRICT,
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
  CONSTRAINT "orders_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "erp_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "correlation_id" text NOT NULL,
  "run_id" uuid REFERENCES "demo_runs"("id") ON DELETE RESTRICT,
  "attempt_number" integer NOT NULL,
  "status" "erp_attempt_status" NOT NULL,
  "http_status" integer,
  "error_code" text,
  "error_message" text,
  "latency_ms" integer NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "erp_attempts_attempt_number_positive" CHECK ("attempt_number" > 0),
  CONSTRAINT "erp_attempts_latency_nonnegative" CHECK ("latency_ms" >= 0),
  CONSTRAINT "erp_attempts_http_status_valid" CHECK (
    "http_status" IS NULL OR ("http_status" >= 100 AND "http_status" <= 599)
  )
);
--> statement-breakpoint
CREATE TABLE "order_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid REFERENCES "orders"("id") ON DELETE SET NULL,
  "reservation_id" uuid REFERENCES "reservations"("id") ON DELETE SET NULL,
  "sale_offer_id" uuid NOT NULL REFERENCES "sale_offers"("id") ON DELETE RESTRICT,
  "correlation_id" text NOT NULL,
  "run_id" uuid REFERENCES "demo_runs"("id") ON DELETE RESTRICT,
  "event_name" "order_event_name" NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservation_pending_persistence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reservation_id" uuid NOT NULL,
  "sale_offer_id" uuid NOT NULL REFERENCES "sale_offers"("id") ON DELETE RESTRICT,
  "correlation_id" text NOT NULL,
  "run_id" uuid REFERENCES "demo_runs"("id") ON DELETE RESTRICT,
  "idempotency_key" text NOT NULL,
  "quantity" integer DEFAULT 1 NOT NULL,
  "reservation_token" text NOT NULL,
  "status" "reservation_pending_persistence_status" DEFAULT 'pending_reconciliation' NOT NULL,
  "secured_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reservation_pending_persistence_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "simulated_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE CASCADE,
  "sale_offer_id" uuid NOT NULL REFERENCES "sale_offers"("id") ON DELETE RESTRICT,
  "correlation_id" text NOT NULL,
  "run_id" uuid REFERENCES "demo_runs"("id") ON DELETE RESTRICT,
  "channel" "simulated_notification_channel" NOT NULL,
  "recipient_placeholder" text NOT NULL,
  "status" "simulated_notification_status" DEFAULT 'recorded' NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_run_reservation_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "demo_runs"("id") ON DELETE CASCADE,
  "outcome" "demo_run_reservation_outcome" NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "latest_observed_at" timestamp with time zone,
  "source" "demo_run_reservation_outcome_source" NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "demo_run_reservation_outcomes_count_nonnegative" CHECK ("count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "demo_run_finalizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "demo_runs"("id") ON DELETE CASCADE,
  "exit_code" integer,
  "error_message" text,
  "http_summary" jsonb NOT NULL,
  "traffic_outcome_summary" jsonb NOT NULL,
  "traffic_delivery_summary" jsonb NOT NULL,
  "http_timing_breakdown_summary" jsonb NOT NULL,
  "load_run_diagnostics_summary" jsonb NOT NULL,
  "api_request_lifecycle_summary" jsonb NOT NULL,
  "traffic_summary_received_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demo_run_summaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "demo_runs"("id") ON DELETE CASCADE,
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
  CONSTRAINT "demo_run_summaries_terminal_status" CHECK ("status" IN ('completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "public_runtime_policies" (
  "id" text PRIMARY KEY DEFAULT 'active' NOT NULL,
  "policy" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "public_runtime_policies_active_singleton" CHECK ("id" = 'active')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_unique" ON "products" ("sku");
--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_unique" ON "products" ("slug");
--> statement-breakpoint
CREATE INDEX "products_is_active_idx" ON "products" ("is_active");
--> statement-breakpoint
CREATE INDEX "sale_offers_product_id_idx" ON "sale_offers" ("product_id");
--> statement-breakpoint
CREATE INDEX "sale_offers_purpose_idx" ON "sale_offers" ("purpose");
--> statement-breakpoint
CREATE INDEX "sale_offers_active_window_idx" ON "sale_offers" (
  "is_active",
  "sale_starts_at",
  "sale_ends_at"
);
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_presets_slug_unique" ON "demo_presets" ("slug");
--> statement-breakpoint
CREATE INDEX "demo_presets_visibility_idx" ON "demo_presets" ("visibility");
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_runs_sale_offer_id_unique" ON "demo_runs" ("sale_offer_id");
--> statement-breakpoint
CREATE INDEX "demo_runs_preset_id_idx" ON "demo_runs" ("preset_id");
--> statement-breakpoint
CREATE INDEX "demo_runs_status_idx" ON "demo_runs" ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_sale_contexts_sale_offer_id_unique" ON "demo_run_sale_contexts" (
  "sale_offer_id"
);
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_sale_contexts_run_sale_offer_unique" ON "demo_run_sale_contexts" (
  "run_id",
  "sale_offer_id"
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_reservation_token_unique" ON "reservations" ("reservation_token");
--> statement-breakpoint
CREATE INDEX "reservations_sale_offer_id_idx" ON "reservations" ("sale_offer_id");
--> statement-breakpoint
CREATE INDEX "reservations_run_id_idx" ON "reservations" ("run_id");
--> statement-breakpoint
CREATE INDEX "reservations_correlation_id_idx" ON "reservations" ("correlation_id");
--> statement-breakpoint
CREATE INDEX "reservations_status_idx" ON "reservations" ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_public_order_id_unique" ON "orders" ("public_order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_reservation_id_unique" ON "orders" ("reservation_id");
--> statement-breakpoint
CREATE INDEX "orders_sale_offer_id_idx" ON "orders" ("sale_offer_id");
--> statement-breakpoint
CREATE INDEX "orders_run_id_idx" ON "orders" ("run_id");
--> statement-breakpoint
CREATE INDEX "orders_correlation_id_idx" ON "orders" ("correlation_id");
--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "erp_attempts_order_attempt_unique" ON "erp_attempts" (
  "order_id",
  "attempt_number"
);
--> statement-breakpoint
CREATE INDEX "erp_attempts_order_id_idx" ON "erp_attempts" ("order_id");
--> statement-breakpoint
CREATE INDEX "erp_attempts_run_id_idx" ON "erp_attempts" ("run_id");
--> statement-breakpoint
CREATE INDEX "order_events_order_id_idx" ON "order_events" ("order_id");
--> statement-breakpoint
CREATE INDEX "order_events_reservation_id_idx" ON "order_events" ("reservation_id");
--> statement-breakpoint
CREATE INDEX "order_events_sale_offer_id_idx" ON "order_events" ("sale_offer_id");
--> statement-breakpoint
CREATE INDEX "order_events_run_id_idx" ON "order_events" ("run_id");
--> statement-breakpoint
CREATE INDEX "order_events_event_name_idx" ON "order_events" ("event_name");
--> statement-breakpoint
CREATE INDEX "order_events_occurred_at_idx" ON "order_events" ("occurred_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_pending_persistence_reservation_id_unique" ON "reservation_pending_persistence" (
  "reservation_id"
);
--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_pending_persistence_offer_idempotency_unique" ON "reservation_pending_persistence" (
  "sale_offer_id",
  "idempotency_key"
);
--> statement-breakpoint
CREATE INDEX "reservation_pending_persistence_sale_offer_id_idx" ON "reservation_pending_persistence" (
  "sale_offer_id"
);
--> statement-breakpoint
CREATE INDEX "reservation_pending_persistence_run_id_idx" ON "reservation_pending_persistence" (
  "run_id"
);
--> statement-breakpoint
CREATE INDEX "reservation_pending_persistence_status_idx" ON "reservation_pending_persistence" (
  "status"
);
--> statement-breakpoint
CREATE INDEX "simulated_notifications_order_id_idx" ON "simulated_notifications" ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "simulated_notifications_order_channel_unique" ON "simulated_notifications" (
  "order_id",
  "channel"
);
--> statement-breakpoint
CREATE INDEX "simulated_notifications_sale_offer_id_idx" ON "simulated_notifications" (
  "sale_offer_id"
);
--> statement-breakpoint
CREATE INDEX "simulated_notifications_run_id_idx" ON "simulated_notifications" ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_reservation_outcomes_run_outcome_unique" ON "demo_run_reservation_outcomes" (
  "run_id",
  "outcome"
);
--> statement-breakpoint
CREATE INDEX "demo_run_reservation_outcomes_run_id_idx" ON "demo_run_reservation_outcomes" (
  "run_id"
);
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_finalizations_run_id_unique" ON "demo_run_finalizations" ("run_id");
--> statement-breakpoint
CREATE INDEX "demo_run_finalizations_run_id_idx" ON "demo_run_finalizations" ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_run_summaries_run_id_unique" ON "demo_run_summaries" ("run_id");
--> statement-breakpoint
CREATE INDEX "demo_run_summaries_captured_at_idx" ON "demo_run_summaries" ("captured_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "set_updated_at"()
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
CREATE OR REPLACE FUNCTION "enforce_demo_run_sale_context_offer_purpose"()
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
CREATE OR REPLACE FUNCTION "enforce_run_owned_sale_offer_attribution"()
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
