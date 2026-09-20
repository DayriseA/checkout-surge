CREATE TABLE "erp_confirmation_ledger" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"public_order_id" text NOT NULL,
	"reservation_id" uuid NOT NULL,
	"sale_offer_id" uuid NOT NULL,
	"run_id" uuid,
	"quantity" integer NOT NULL,
	"terminal_result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "erp_confirmation_ledger_quantity_positive" CHECK ("erp_confirmation_ledger"."quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX "erp_confirmation_ledger_run_id_idx" ON "erp_confirmation_ledger" USING btree ("run_id");