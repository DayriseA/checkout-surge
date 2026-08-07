CREATE INDEX "erp_attempts_run_id_correlation_id_idx" ON "erp_attempts" USING btree ("run_id","correlation_id");--> statement-breakpoint
CREATE INDEX "order_events_run_id_correlation_id_idx" ON "order_events" USING btree ("run_id","correlation_id");--> statement-breakpoint
CREATE INDEX "orders_run_id_correlation_id_idx" ON "orders" USING btree ("run_id","correlation_id");--> statement-breakpoint
CREATE INDEX "simulated_notifications_run_id_correlation_id_idx" ON "simulated_notifications" USING btree ("run_id","correlation_id");