import type { ReadinessCheck } from "@checkout-surge/contracts";
import { createReadinessCheck } from "@checkout-surge/logger";
import type { Redis } from "ioredis";
import type { OrderProcessConsumer } from "../queue/order-process-consumer.js";

export interface WorkerReadiness {
  checks(): Promise<ReadinessCheck[]>;
}

export function createWorkerReadiness(dependencies: {
  redis: Redis;
  orderProcessConsumer: OrderProcessConsumer;
}): WorkerReadiness {
  return {
    checks: async () => {
      const checks: ReadinessCheck[] = [];

      try {
        await dependencies.redis.ping();
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

      const isConsumerRunning = dependencies.orderProcessConsumer.isRunning();
      checks.push(
        createReadinessCheck({
          name: "order_process_worker_running",
          status: isConsumerRunning ? "ok" : "unavailable",
          ...(!isConsumerRunning
            ? { message: "The order-processing consumer is not running." }
            : {}),
        }),
      );

      return checks;
    },
  };
}
