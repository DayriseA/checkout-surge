-- Prevent writes from racing the legacy audit or guard installation. Drizzle runs
-- this migration in one transaction, so these locks remain held through validation.
LOCK TABLE "reservations", "orders", "erp_attempts", "order_events"
  IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Historical contradictions require explicit reconciliation. Lifecycle timestamps
-- and duplicated attribution cannot be reconstructed safely by this migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "reservations"
    WHERE "status" = 'released'::"reservation_status" AND "released_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot enforce reservation release timestamps: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'reservations_released_requires_released_at';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "reservations"
    WHERE "status" = 'expired'::"reservation_status" AND "expired_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot enforce reservation expiry timestamps: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'reservations_expired_requires_expired_at';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "orders"
    WHERE "status" = 'confirmed'::"order_status" AND "confirmed_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot enforce confirmed order timestamps: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_confirmed_requires_confirmed_at';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "orders"
    WHERE "status" = 'failed'::"order_status" AND "failed_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot enforce failed order timestamps: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_failed_requires_failed_at';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "orders"
    WHERE "status" IN ('processing', 'confirmed', 'failed') AND "processing_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot enforce order processing timestamps: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_in_progress_requires_processing_at';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "orders"
    WHERE ("confirmed_at" IS NOT NULL AND "confirmed_at" < "queued_at")
       OR ("failed_at" IS NOT NULL AND "failed_at" < "queued_at")
  ) THEN
    RAISE EXCEPTION 'cannot enforce order terminal timestamp ordering: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'orders_terminal_timestamps_after_queued_at';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "erp_attempts" WHERE "finished_at" < "started_at"
  ) THEN
    RAISE EXCEPTION 'cannot enforce ERP attempt timestamp ordering: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'erp_attempts_finished_after_started';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "erp_attempts" AS attempt
    INNER JOIN "orders" AS parent_order ON parent_order."id" = attempt."order_id"
    WHERE attempt."run_id" IS DISTINCT FROM parent_order."run_id"
       OR attempt."correlation_id" IS DISTINCT FROM parent_order."correlation_id"
  ) THEN
    RAISE EXCEPTION 'cannot enforce ERP attempt order attribution: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'erp_attempts_order_attribution_agreement';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "order_events" AS event
    INNER JOIN "orders" AS parent_order ON parent_order."id" = event."order_id"
    WHERE event."reservation_id" IS DISTINCT FROM parent_order."reservation_id"
       OR event."sale_offer_id" IS DISTINCT FROM parent_order."sale_offer_id"
       OR event."run_id" IS DISTINCT FROM parent_order."run_id"
       OR event."correlation_id" IS DISTINCT FROM parent_order."correlation_id"
  ) THEN
    RAISE EXCEPTION 'cannot enforce order-event order attribution: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'order_events_order_attribution_agreement';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "order_events" AS event
    INNER JOIN "reservations" AS reservation ON reservation."id" = event."reservation_id"
    WHERE event."order_id" IS NULL
      AND (event."sale_offer_id" IS DISTINCT FROM reservation."sale_offer_id"
        OR event."run_id" IS DISTINCT FROM reservation."run_id"
        OR event."correlation_id" IS DISTINCT FROM reservation."correlation_id")
  ) THEN
    RAISE EXCEPTION 'cannot enforce reservation-only event attribution: contradictory historical rows require explicit reconciliation'
      USING ERRCODE = '23514', CONSTRAINT = 'order_events_reservation_attribution_agreement';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_released_requires_released_at"
  CHECK ("status" <> 'released' OR "released_at" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_expired_requires_expired_at"
  CHECK ("status" <> 'expired' OR "expired_at" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_requires_confirmed_at"
  CHECK ("status" <> 'confirmed' OR "confirmed_at" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_failed_requires_failed_at"
  CHECK ("status" <> 'failed' OR "failed_at" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_in_progress_requires_processing_at"
  CHECK ("status" NOT IN ('processing', 'confirmed', 'failed') OR "processing_at" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_terminal_timestamps_after_queued_at"
  CHECK (("confirmed_at" IS NULL OR "confirmed_at" >= "queued_at") AND ("failed_at" IS NULL OR "failed_at" >= "queued_at")) NOT VALID;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD CONSTRAINT "erp_attempts_finished_after_started"
  CHECK ("finished_at" >= "started_at") NOT VALID;
--> statement-breakpoint
ALTER TABLE "reservations" VALIDATE CONSTRAINT "reservations_released_requires_released_at";
--> statement-breakpoint
ALTER TABLE "reservations" VALIDATE CONSTRAINT "reservations_expired_requires_expired_at";
--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_confirmed_requires_confirmed_at";
--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_failed_requires_failed_at";
--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_in_progress_requires_processing_at";
--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_terminal_timestamps_after_queued_at";
--> statement-breakpoint
ALTER TABLE "erp_attempts" VALIDATE CONSTRAINT "erp_attempts_finished_after_started";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_erp_attempt_order_attribution"()
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
CREATE OR REPLACE FUNCTION "enforce_order_event_parent_attribution"()
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
CREATE OR REPLACE FUNCTION "preserve_order_child_attribution"()
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
CREATE OR REPLACE FUNCTION "preserve_reservation_only_event_attribution"()
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
