import {
  type CheckoutSurgeRedis,
  createRedisClient,
  getInventoryStatus,
  getPostgresInventoryStatus,
} from "@checkout-surge/db";
import { sql } from "drizzle-orm";
import type { TerminalInventoryReadOperation } from "../services/demo-run-finalization-service.js";
import { createOperationResourceCleanup, runWithResourceCleanup } from "./api-resource-cleanup.js";
import { abortReason, settleWithAbort } from "./operation-lifecycle.js";

export interface TerminalInventoryReadConfig {
  redisUrl: string;
  timeoutMs: number;
}

export interface TerminalInventoryReadInfrastructure {
  createRedis(
    redisUrl: string,
    options: {
      lazyConnect: boolean;
      maxRetriesPerRequest: number;
      commandTimeout: number;
    },
  ): CheckoutSurgeRedis;
  readInventory: typeof getInventoryStatus;
  readPostgresInventory: typeof getPostgresInventoryStatus;
}

const terminalInventoryReadInfrastructure: TerminalInventoryReadInfrastructure = {
  createRedis: createRedisClient,
  readInventory: getInventoryStatus,
  readPostgresInventory: getPostgresInventoryStatus,
};

export function createTerminalInventoryReadOperation(
  config: TerminalInventoryReadConfig,
  infrastructure: TerminalInventoryReadInfrastructure = terminalInventoryReadInfrastructure,
): TerminalInventoryReadOperation {
  return {
    read: async ({ saleOfferId, executionMode, db, observedAt, signal }) => {
      if (signal.aborted) throw abortReason(signal);
      // The terminal fence owns this transaction. Never reserve or close its connection.
      if (executionMode === "without_redis") {
        // On the caller's Drizzle transaction this is a native driver savepoint,
        // including its error scope; a manual SAVEPOINT would poison postgres.js begin().
        return db.transaction(async (readDb) => {
          const [policy] = await readDb.execute<{ timeout: string }>(
            sql`select current_setting('statement_timeout') as timeout`,
          );
          await readDb.execute(
            sql`select set_config('statement_timeout', ${String(config.timeoutMs)}, true)`,
          );
          if (signal.aborted) throw abortReason(signal);
          // Abort ends observation; the server timeout bounds SQL still running.
          // Await native savepoint recovery before returning the borrowed transaction.
          const inventory = await settleWithAbort(
            infrastructure.readPostgresInventory(readDb, saleOfferId, observedAt),
            signal,
          );
          await readDb.execute(
            sql`select set_config('statement_timeout', ${policy?.timeout ?? "0"}, true)`,
          );
          return inventory;
        });
      }
      const redis = infrastructure.createRedis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        commandTimeout: config.timeoutMs,
      });
      const close = createOperationResourceCleanup({
        signal,
        operations: [() => redis.disconnect()],
        failureMessage: "Terminal inventory read resource cleanup failed.",
      });
      return await runWithResourceCleanup(
        () => settleWithAbort(infrastructure.readInventory(redis, saleOfferId, observedAt), signal),
        close,
        "Terminal inventory read and cleanup failed.",
      );
    },
  };
}
