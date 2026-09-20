ALTER TABLE "demo_runs" DROP COLUMN "administrative_stop";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "failure_category" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."order_failure_category";--> statement-breakpoint
CREATE TYPE "public"."order_failure_category" AS ENUM('business_rejection', 'technical');--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "failure_category" SET DATA TYPE "public"."order_failure_category" USING "failure_category"::"public"."order_failure_category";
