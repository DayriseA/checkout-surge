CREATE TYPE "public"."traffic_completion_enrichment_status" AS ENUM('pending', 'completed');--> statement-breakpoint
ALTER TABLE "demo_run_finalizations" ADD COLUMN "completion_enrichment_status" "traffic_completion_enrichment_status" DEFAULT 'completed' NOT NULL;
