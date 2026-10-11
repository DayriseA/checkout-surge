import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRuns,
  getInventoryStatus,
  getPostgresInventoryStatus,
} from "@checkout-surge/db";
import { eq } from "drizzle-orm";
import type { InventoryStatusReader } from "../services/inventory-status-service.js";

/** Explicit scopes reuse their accepted mode; only standalone reads resolve ownership. */
export function createInventoryStatusReader(
  db: CheckoutSurgeDatabase,
  redis: CheckoutSurgeRedis,
): InventoryStatusReader {
  return {
    async getStatus(saleOfferId, scope) {
      let executionMode = scope?.executionMode;
      if (!scope) {
        const [owner] = await db
          .select({ executionMode: demoRuns.executionMode })
          .from(demoRuns)
          .where(eq(demoRuns.saleOfferId, saleOfferId))
          .limit(1);
        executionMode = owner?.executionMode;
      }
      return executionMode === "without_redis"
        ? getPostgresInventoryStatus(db, saleOfferId)
        : getInventoryStatus(redis, saleOfferId);
    },
  };
}
