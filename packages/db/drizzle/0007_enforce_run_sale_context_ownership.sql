-- A run and its sale context duplicate sale-offer ownership so both columns can
-- serve their respective read paths. Refuse to guess which value is authoritative
-- if an older database already contains contradictory ownership.
DO $$
DECLARE
  contradictory_row_count bigint;
BEGIN
  SELECT count(*)
  INTO contradictory_row_count
  FROM "demo_run_sale_contexts" AS context
  INNER JOIN "demo_runs" AS run ON run."id" = context."run_id"
  WHERE run."sale_offer_id" IS DISTINCT FROM context."sale_offer_id";

  IF contradictory_row_count > 0 THEN
    RAISE EXCEPTION 'cannot enforce run-sale-context ownership: % contradictory row(s) require explicit reconciliation before retrying migration', contradictory_row_count
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'demo_run_sale_contexts_existing_ownership_consistency';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "demo_runs_id_sale_offer_id_unique"
  ON "demo_runs" ("id", "sale_offer_id");
--> statement-breakpoint
ALTER TABLE "demo_run_sale_contexts"
  ADD CONSTRAINT "demo_run_sale_contexts_run_sale_offer_demo_runs_fk"
  FOREIGN KEY ("run_id", "sale_offer_id")
  REFERENCES "demo_runs" ("id", "sale_offer_id")
  ON DELETE CASCADE;
