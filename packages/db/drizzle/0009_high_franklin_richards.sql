ALTER TABLE "erp_scope_resilience_state" ADD COLUMN "availability_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erp_scope_resilience_state" ADD COLUMN "availability_circuit_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "erp_scope_resilience_state" ADD COLUMN "next_probe_at" timestamp with time zone;--> statement-breakpoint
UPDATE "erp_scope_resilience_state"
SET
	"availability_retry_at" = "circuit_open_expires_at",
	"availability_circuit_open" = true,
	"next_probe_at" = "circuit_open_expires_at"
WHERE "circuit_open_expires_at" IS NOT NULL;
