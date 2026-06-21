import type { ReadinessCheck } from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis, SqlClient } from "@checkout-surge/db";
import { createReadinessCheck } from "@checkout-surge/logger";

export interface ApiReadiness {
  checks: () => Promise<ReadinessCheck[]>;
}

export function createInfrastructureReadinessCheck(
  sql: SqlClient,
  redis: CheckoutSurgeRedis,
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

      return checks;
    },
  };
}
