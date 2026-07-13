CREATE TABLE IF NOT EXISTS "demo_run_teardown_receipts" (
  "run_id" uuid PRIMARY KEY NOT NULL,
  "sale_offer_id" uuid NOT NULL,
  "preset_name" text NOT NULL,
  "durable_deleted_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_run_teardown_receipts_sale_offer_id_idx"
  ON "demo_run_teardown_receipts" ("sale_offer_id");
