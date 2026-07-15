ALTER TABLE "erp_attempts" ADD COLUMN IF NOT EXISTS "terminal" boolean;
--> statement-breakpoint
UPDATE "erp_attempts"
SET "terminal" = true
WHERE "status" = 'succeeded'::"erp_attempt_status";
--> statement-breakpoint
WITH latest_attempts AS (
  SELECT DISTINCT ON ("order_id")
    "id",
    "order_id",
    "status"
  FROM "erp_attempts"
  ORDER BY "order_id", "finished_at" DESC, "created_at" DESC, "id" DESC
)
UPDATE "erp_attempts" AS attempts
SET "terminal" = true
WHERE attempts."id" IN (
  SELECT latest_attempts."id"
  FROM latest_attempts
  INNER JOIN "orders" ON "orders"."id" = latest_attempts."order_id"
  WHERE "orders"."status" = 'failed'::"order_status"
    AND latest_attempts."status" IN (
      'failed'::"erp_attempt_status",
      'timed_out'::"erp_attempt_status"
    )
);
--> statement-breakpoint
UPDATE "erp_attempts"
SET "terminal" = false
WHERE "terminal" IS NULL;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ALTER COLUMN "terminal" SET DEFAULT false;
--> statement-breakpoint
ALTER TABLE "erp_attempts" ALTER COLUMN "terminal" SET NOT NULL;
