-- HAND-AUTHORED DATABASE OBJECTS: Drizzle snapshots do not represent these
-- functions or triggers. Preserve this journaled migration during generation,
-- reset, packaging, and deployment work.
--
-- CREATE OR REPLACE plus table-specific DROP TRIGGER makes this migration
-- converge both fresh installs and databases where these objects were installed
-- by the historical 0000 migration before they were moved here.

CREATE OR REPLACE FUNCTION "set_updated_at"()
RETURNS trigger AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "products_set_updated_at" ON "products";
--> statement-breakpoint
CREATE TRIGGER "products_set_updated_at"
BEFORE UPDATE ON "products"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sale_offers_set_updated_at" ON "sale_offers";
--> statement-breakpoint
CREATE TRIGGER "sale_offers_set_updated_at"
BEFORE UPDATE ON "sale_offers"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demo_presets_set_updated_at" ON "demo_presets";
--> statement-breakpoint
CREATE TRIGGER "demo_presets_set_updated_at"
BEFORE UPDATE ON "demo_presets"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demo_runs_set_updated_at" ON "demo_runs";
--> statement-breakpoint
CREATE TRIGGER "demo_runs_set_updated_at"
BEFORE UPDATE ON "demo_runs"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demo_run_sale_contexts_set_updated_at" ON "demo_run_sale_contexts";
--> statement-breakpoint
CREATE TRIGGER "demo_run_sale_contexts_set_updated_at"
BEFORE UPDATE ON "demo_run_sale_contexts"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "reservations_set_updated_at" ON "reservations";
--> statement-breakpoint
CREATE TRIGGER "reservations_set_updated_at"
BEFORE UPDATE ON "reservations"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "orders_set_updated_at" ON "orders";
--> statement-breakpoint
CREATE TRIGGER "orders_set_updated_at"
BEFORE UPDATE ON "orders"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "reservation_pending_persistence_set_updated_at" ON "reservation_pending_persistence";
--> statement-breakpoint
CREATE TRIGGER "reservation_pending_persistence_set_updated_at"
BEFORE UPDATE ON "reservation_pending_persistence"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "demo_run_finalizations_set_updated_at" ON "demo_run_finalizations";
--> statement-breakpoint
CREATE TRIGGER "demo_run_finalizations_set_updated_at"
BEFORE UPDATE ON "demo_run_finalizations"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "public_runtime_policies_set_updated_at" ON "public_runtime_policies";
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
DROP TRIGGER IF EXISTS "demo_run_sale_contexts_enforce_offer_purpose" ON "demo_run_sale_contexts";
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
DROP TRIGGER IF EXISTS "reservations_enforce_run_owned_sale_offer_attribution" ON "reservations";
--> statement-breakpoint
CREATE TRIGGER "reservations_enforce_run_owned_sale_offer_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "reservations"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "orders_enforce_run_owned_sale_offer_attribution" ON "orders";
--> statement-breakpoint
CREATE TRIGGER "orders_enforce_run_owned_sale_offer_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "orders"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "rpp_enforce_run_sale_attribution" ON "reservation_pending_persistence";
--> statement-breakpoint
CREATE TRIGGER "rpp_enforce_run_sale_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "reservation_pending_persistence"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "order_events_enforce_run_owned_sale_offer_attribution" ON "order_events";
--> statement-breakpoint
CREATE TRIGGER "order_events_enforce_run_owned_sale_offer_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "order_events"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "sim_notifications_enforce_run_sale_attribution" ON "simulated_notifications";
--> statement-breakpoint
CREATE TRIGGER "sim_notifications_enforce_run_sale_attribution"
BEFORE INSERT OR UPDATE OF "sale_offer_id", "run_id" ON "simulated_notifications"
FOR EACH ROW EXECUTE FUNCTION "enforce_run_owned_sale_offer_attribution"();
