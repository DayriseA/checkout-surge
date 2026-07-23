import { type CheckoutSurgeRedis, createRedisClient, getInventoryStatus } from "@checkout-surge/db";
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
}

const terminalInventoryReadInfrastructure: TerminalInventoryReadInfrastructure = {
  createRedis: createRedisClient,
  readInventory: getInventoryStatus,
};

export function createTerminalInventoryReadOperation(
  config: TerminalInventoryReadConfig,
  infrastructure: TerminalInventoryReadInfrastructure = terminalInventoryReadInfrastructure,
): TerminalInventoryReadOperation {
  return {
    read: async ({ saleOfferId, observedAt, signal }) => {
      if (signal.aborted) throw abortReason(signal);
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
