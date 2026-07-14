ALTER TABLE "demo_presets" ADD COLUMN IF NOT EXISTS "is_system" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "demo_presets" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_presets_archived_at_idx"
  ON "demo_presets" ("archived_at");
--> statement-breakpoint
UPDATE "demo_presets"
  SET "is_system" = true
  WHERE "slug" IN (
    'preview-1k',
    'surge-5k',
    'surge-10k',
    'idempotency-check-200',
    'public-custom',
    'admin-smoke-steady',
    'admin-failure-path',
    'custom'
  );
