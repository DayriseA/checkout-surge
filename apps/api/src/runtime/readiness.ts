import type { ReadinessCheck } from "@checkout-surge/contracts";
import type { SqlClient } from "@checkout-surge/db";
import { createReadinessCheck } from "@checkout-surge/logger";

export interface ApiReadiness {
  checks: () => Promise<ReadinessCheck[]>;
}

export function createDatabaseReadinessCheck(
  sql: SqlClient,
  redisUrl: string | null,
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

      checks.push(
        createReadinessCheck({
          name: "redis_url_configured",
          status: redisUrl ? "ok" : "degraded",
          ...(redisUrl ? {} : { message: "REDIS_URL is not configured." }),
        }),
      );

      return checks;
    },
  };
}
