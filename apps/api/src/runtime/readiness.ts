import type { ReadinessCheck } from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis, SqlClient } from "@checkout-surge/db";
import { createReadinessCheck } from "@checkout-surge/logger";
import type { QueueConnectivityChecker } from "../services/queue-status-service.js";

export interface ApiReadiness {
  checks: () => Promise<ReadinessCheck[]>;
}

export function createInfrastructureReadinessCheck(
  sql: SqlClient,
  redis: CheckoutSurgeRedis,
  queue: QueueConnectivityChecker,
): ApiReadiness {
  return {
    checks: async () => {
      const checks: ReadinessCheck[] = [];

      try {
        await sql`SELECT 1`;
        checks.push(createReadinessCheck({ name: "database_reachable", status: "ok" }));
      } catch (error) {
        checks.push(
          createReadinessCheck({
            name: "database_reachable",
            status: "unavailable",
            message: error instanceof Error ? error.message : "Database check failed.",
          }),
        );
      }

      try {
        await redis.ping();
        checks.push(createReadinessCheck({ name: "redis_reachable", status: "ok" }));
      } catch (error) {
        checks.push(
          createReadinessCheck({
            name: "redis_reachable",
            status: "unavailable",
            message: error instanceof Error ? error.message : "Redis check failed.",
          }),
        );
      }

      try {
        await queue.checkConnectivity();
        checks.push(createReadinessCheck({ name: "order_process_queue_reachable", status: "ok" }));
      } catch (error) {
        checks.push(
          createReadinessCheck({
            name: "order_process_queue_reachable",
            status: "unavailable",
            message: error instanceof Error ? error.message : "Queue check failed.",
          }),
        );
      }

      return checks;
    },
  };
}
