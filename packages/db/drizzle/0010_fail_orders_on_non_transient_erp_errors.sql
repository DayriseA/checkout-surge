ALTER TYPE "public"."order_failure_category" ADD VALUE 'technical' BEFORE 'administrative';--> statement-breakpoint
ALTER TABLE "erp_attempts" ALTER COLUMN "disposition" SET DATA TYPE text;--> statement-breakpoint
UPDATE "erp_attempts" SET "disposition" = 'technical_failure' WHERE "disposition" = 'intervention_required';--> statement-breakpoint
DROP TYPE "public"."erp_outcome_disposition";--> statement-breakpoint
CREATE TYPE "public"."erp_outcome_disposition" AS ENUM('succeeded', 'capacity_rejected', 'temporarily_unavailable', 'uncertain_result', 'permanent_rejection', 'technical_failure');--> statement-breakpoint
ALTER TABLE "erp_attempts" ALTER COLUMN "disposition" SET DATA TYPE "public"."erp_outcome_disposition" USING "disposition"::"public"."erp_outcome_disposition";--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ALTER COLUMN "waiting_reason" SET DATA TYPE text;--> statement-breakpoint
UPDATE "order_recovery_jobs" SET "waiting_reason" = NULL WHERE "waiting_reason" = 'intervention_required';--> statement-breakpoint
DROP TYPE "public"."order_waiting_reason";--> statement-breakpoint
CREATE TYPE "public"."order_waiting_reason" AS ENUM('local_admission', 'erp_capacity', 'erp_unavailable', 'uncertain_result');--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" ALTER COLUMN "waiting_reason" SET DATA TYPE "public"."order_waiting_reason" USING "waiting_reason"::"public"."order_waiting_reason";--> statement-breakpoint
ALTER TABLE "erp_scope_resilience_state" DROP COLUMN "intervention_reason";--> statement-breakpoint
ALTER TABLE "erp_scope_resilience_state" DROP COLUMN "intervention_opened_at";--> statement-breakpoint
ALTER TABLE "order_recovery_jobs" DROP COLUMN "intervention_reason";
