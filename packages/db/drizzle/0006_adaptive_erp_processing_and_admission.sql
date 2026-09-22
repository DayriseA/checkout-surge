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
CREATE INDEX "erp_confirmation_ledger_run_id_idx" ON "erp_confirmation_ledger" USING btree ("run_id");--> statement-breakpoint
CREATE TYPE "public"."erp_outcome_disposition" AS ENUM('succeeded', 'capacity_rejected', 'temporarily_unavailable', 'uncertain_result', 'permanent_rejection', 'technical_failure');--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD COLUMN "disposition" "erp_outcome_disposition";--> statement-breakpoint
UPDATE "erp_attempts"
SET "disposition" = CASE
	WHEN "status" = 'succeeded' THEN 'succeeded'::"erp_outcome_disposition"
	WHEN "status" = 'timed_out' THEN 'uncertain_result'::"erp_outcome_disposition"
	WHEN "error_code" = 'erp_capacity_exceeded' THEN 'capacity_rejected'::"erp_outcome_disposition"
	WHEN "error_code" IN ('erp_forced_outage', 'erp_injected_error', 'erp_request_failed') THEN 'temporarily_unavailable'::"erp_outcome_disposition"
	ELSE 'technical_failure'::"erp_outcome_disposition"
END;--> statement-breakpoint
WITH matched_attempts AS (
	SELECT
		"order_events"."id" AS "event_id",
		"erp_attempts"."id" AS "attempt_id",
		"erp_attempts"."erp_call_id",
		"erp_attempts"."disposition",
		("erp_attempts"."idempotency_key" IS NOT NULL) AS "canonical",
		row_number() OVER (
			PARTITION BY "order_events"."id"
			ORDER BY "erp_attempts"."created_at" DESC, "erp_attempts"."id" DESC
		) AS "match_rank"
	FROM "order_events"
	INNER JOIN "erp_attempts" ON
		"erp_attempts"."order_id" = "order_events"."order_id"
		AND "erp_attempts"."finished_at" = "order_events"."occurred_at"
		AND "erp_attempts"."attempt_number" = CASE
			WHEN "order_events"."payload" ->> 'attemptNumber' ~ '^[0-9]+$'
			THEN ("order_events"."payload" ->> 'attemptNumber')::integer
		END
		AND (
			("order_events"."event_name" = 'erp.attempt.succeeded' AND "erp_attempts"."status" = 'succeeded')
			OR ("order_events"."event_name" = 'erp.attempt.failed' AND "erp_attempts"."status" <> 'succeeded')
		)
	WHERE "order_events"."event_name" IN ('erp.attempt.failed', 'erp.attempt.succeeded')
)
UPDATE "order_events"
SET "payload" = "order_events"."payload" || jsonb_strip_nulls(jsonb_build_object(
	'erpAttemptId', "matched_attempts"."attempt_id",
	'erpCallId', "matched_attempts"."erp_call_id",
	'disposition', "matched_attempts"."disposition",
	'canonical', "matched_attempts"."canonical"
))
FROM "matched_attempts"
WHERE "order_events"."id" = "matched_attempts"."event_id"
	AND "matched_attempts"."match_rank" = 1;--> statement-breakpoint
ALTER TABLE "erp_scope_resilience_state" ADD COLUMN "availability_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erp_scope_resilience_state" ADD COLUMN "availability_circuit_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "erp_scope_resilience_state" ADD COLUMN "next_probe_at" timestamp with time zone;--> statement-breakpoint
UPDATE "erp_scope_resilience_state"
SET
	"availability_retry_at" = "circuit_open_expires_at",
	"availability_circuit_open" = true,
	"next_probe_at" = "circuit_open_expires_at"
WHERE "circuit_open_expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ALTER COLUMN "waiting_reason" SET DATA TYPE text;--> statement-breakpoint
UPDATE "order_recovery_jobs" SET "waiting_reason" = NULL WHERE "waiting_reason" = 'intervention_required';--> statement-breakpoint
DROP TYPE "public"."order_waiting_reason";--> statement-breakpoint
CREATE TYPE "public"."order_waiting_reason" AS ENUM('local_admission', 'erp_capacity', 'erp_unavailable', 'uncertain_result');--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ALTER COLUMN "waiting_reason" SET DATA TYPE "public"."order_waiting_reason" USING "waiting_reason"::"public"."order_waiting_reason";--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" DROP COLUMN "intervention_reason";--> statement-breakpoint
ALTER TABLE "demo_runs" DROP COLUMN "administrative_stop";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "failure_category" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."order_failure_category";--> statement-breakpoint
CREATE TYPE "public"."order_failure_category" AS ENUM('business_rejection', 'technical');--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "failure_category" SET DATA TYPE "public"."order_failure_category" USING "failure_category"::"public"."order_failure_category";--> statement-breakpoint
ALTER TABLE "demo_runs" ADD COLUMN "engine_policy_name" text;--> statement-breakpoint
ALTER TABLE "demo_runs" ADD COLUMN "engine_policy_version" integer;
