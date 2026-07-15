-- Run-history detail reads filter by run_id and return the newest 20 rows.
-- Ordinary CREATE INDEX is intentional: the pinned Drizzle postgres-js migrator
-- applies pending migrations in one transaction, where CONCURRENTLY is invalid.
CREATE INDEX "orders_run_id_queued_at_created_at_idx"
  ON "orders" USING btree ("run_id", "queued_at" DESC, "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "erp_attempts_run_id_finished_at_created_at_idx"
  ON "erp_attempts" USING btree ("run_id", "finished_at" DESC, "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "simulated_notifications_run_id_recorded_at_created_at_idx"
  ON "simulated_notifications" USING btree ("run_id", "recorded_at" DESC, "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "order_events_run_id_occurred_at_created_at_idx"
  ON "order_events" USING btree ("run_id", "occurred_at" DESC, "created_at" DESC);
