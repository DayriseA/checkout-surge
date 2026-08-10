ALTER TABLE "demo_runs" ADD COLUMN "admin_reset_completed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "demo_runs"
SET "admin_reset_completed_at" = "demo_run_summaries"."captured_at"
FROM "demo_run_summaries"
WHERE "demo_runs"."id" = "demo_run_summaries"."run_id"
  AND "demo_runs"."status" = 'failed'
  AND "demo_runs"."failure_reason" = 'admin_reset';
