import { setTimeout as delay } from "node:timers/promises";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  deleteSettledRunInventory,
  getInventoryStatus,
  getPostgresInventoryStatus,
  initializeDashboardProjectionScope,
  initializeInventory,
  PostgresStockReservations,
  postgresOrderDeliveries,
  retireDashboardProjectionScope,
  retireSettledPostgresRunInventory,
  type SqlClient,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import { and, gt, inArray, isNull } from "drizzle-orm";
import type { RunInventoryLifecycle } from "../services/run-inventory-lifecycle.js";

/** Composes existing clients; the PostgreSQL adapter never creates a pool. */
export function createRunInventoryLifecycle(
  db: CheckoutSurgeDatabase,
  redis: CheckoutSurgeRedis,
): RunInventoryLifecycle {
  const stock = new PostgresStockReservations(
    (db as CheckoutSurgeDatabase & { $client: SqlClient }).$client,
  );
  return {
    async initialize(scope, allocatedStock, initializedAt) {
      if (scope.executionMode === "without_redis") {
        await stock.initialize({ ...scope, allocatedStock, now: initializedAt });
        await initializeDashboardProjectionScope(redis, scope);
      } else {
        await initializeInventory(redis, {
          saleOfferId: scope.saleOfferId,
          allocatedStock,
          source: "demo_run_start",
          initializedAt,
          run: { runId: scope.runId, status: "accepting" },
        });
      }
    },
    close: (scope) =>
      scope.executionMode === "without_redis"
        ? stock.close(scope)
        : setRunSaleEligibility(redis, { ...scope, status: "closed" }),
    read: (scope, observedAt) =>
      scope.executionMode === "without_redis"
        ? getPostgresInventoryStatus(db, scope.saleOfferId, observedAt)
        : getInventoryStatus(redis, scope.saleOfferId, observedAt),
    async retire(scope) {
      if (scope.executionMode !== "without_redis")
        return (await deleteSettledRunInventory(redis, scope)).outcome;
      const result = await retireSettledPostgresRunInventory(db, scope);
      if (result === "deleted") await retireDashboardProjectionScope(redis, scope);
      return result;
    },
    async settleProcessing(runIds, deadline) {
      while (runIds.length > 0 && performance.now() < deadline) {
        const [leased] = await db
          .select({ id: postgresOrderDeliveries.publicationId })
          .from(postgresOrderDeliveries)
          .where(
            and(
              inArray(postgresOrderDeliveries.runId, runIds),
              isNull(postgresOrderDeliveries.settledAt),
              gt(postgresOrderDeliveries.leaseUntil, new Date()),
            ),
          )
          .limit(1);
        if (!leased) return;
        await delay(Math.min(100, Math.max(0, deadline - performance.now())));
      }
    },
  };
}
