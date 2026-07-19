import type { ReadinessCheck } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeRedis,
  createAbortableSqlClient,
  type SqlClient,
} from "@checkout-surge/db";
import { createReadinessCheck } from "@checkout-surge/logger";
import type { QueueConnectivityChecker } from "../services/queue-status-service.js";
import { OperationDeadlineExceededError, settleWithAbort } from "./operation-lifecycle.js";

export interface ApiReadiness {
  checks: () => Promise<ReadinessCheck[]>;
}

export interface BoundedReadinessDependency {
  name: string;
  check(signal: AbortSignal): Promise<void>;
}

export function createBoundedInfrastructureReadinessCheck(
  dependencies: readonly BoundedReadinessDependency[],
  timeoutMs: number,
): ApiReadiness {
  let inFlightChecks: Promise<ReadinessCheck[]> | undefined;

  const runChecks = async (): Promise<ReadinessCheck[]> => {
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(new OperationDeadlineExceededError(timeoutMs)),
      timeoutMs,
    );
    deadline.unref();

    try {
      return await Promise.all(
        dependencies.map(async (dependency) => {
          try {
            await settleWithAbort(dependency.check(controller.signal), controller.signal);
            return createReadinessCheck({ name: dependency.name, status: "ok" });
          } catch (error) {
            return createReadinessCheck({
              name: dependency.name,
              status: "unavailable",
              message:
                controller.signal.reason instanceof OperationDeadlineExceededError
                  ? `Check exceeded the ${timeoutMs}ms readiness deadline.`
                  : error instanceof Error
                    ? error.message
                    : "Dependency check failed.",
            });
          }
        }),
      );
    } finally {
      clearTimeout(deadline);
    }
  };

  return {
    checks: async () => {
      let operation = inFlightChecks;
      if (!operation) {
        operation = runChecks();
        inFlightChecks = operation;
        const clearOperation = () => {
          if (inFlightChecks === operation) inFlightChecks = undefined;
        };
        void operation.then(clearOperation, clearOperation);
      }
      const checks = await operation;
      return checks.map((check) => ({ ...check }));
    },
  };
}

/** Compatibility constructor for tests and host adapters with caller-owned clients. */
export function createInfrastructureReadinessCheck(
  sql: SqlClient,
  redis: CheckoutSurgeRedis,
  queue: QueueConnectivityChecker,
  timeoutMs = 2_000,
): ApiReadiness {
  return createBoundedInfrastructureReadinessCheck(
    [
      {
        name: "database_reachable",
        check: async (signal) => {
          await createAbortableSqlClient(sql, signal)`SELECT 1`;
        },
      },
      { name: "redis_reachable", check: async () => void (await redis.ping()) },
      {
        name: "order_process_queue_reachable",
        check: async () => queue.checkConnectivity(),
      },
    ],
    timeoutMs,
  );
}
