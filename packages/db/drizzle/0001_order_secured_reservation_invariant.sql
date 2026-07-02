CREATE OR REPLACE FUNCTION "enforce_order_backing_secured_reservation"()
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
CREATE OR REPLACE FUNCTION "preserve_order_backing_secured_reservation"()
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
