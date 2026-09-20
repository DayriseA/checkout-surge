CREATE TYPE "public"."erp_outcome_disposition" AS ENUM('succeeded', 'capacity_rejected', 'temporarily_unavailable', 'uncertain_result', 'permanent_rejection', 'intervention_required');--> statement-breakpoint
ALTER TABLE "erp_attempts" ADD COLUMN "disposition" "erp_outcome_disposition";--> statement-breakpoint
UPDATE "erp_attempts"
SET "disposition" = CASE
	WHEN "status" = 'succeeded' THEN 'succeeded'::"erp_outcome_disposition"
	WHEN "status" = 'timed_out' THEN 'uncertain_result'::"erp_outcome_disposition"
	WHEN "error_code" = 'erp_capacity_exceeded' THEN 'capacity_rejected'::"erp_outcome_disposition"
	WHEN "error_code" IN ('erp_forced_outage', 'erp_injected_error', 'erp_request_failed') THEN 'temporarily_unavailable'::"erp_outcome_disposition"
	ELSE 'intervention_required'::"erp_outcome_disposition"
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
	AND "matched_attempts"."match_rank" = 1;
