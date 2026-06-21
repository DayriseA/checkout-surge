import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { OrderProcessConsumer } from "../queue/order-process-consumer.js";
import type { WorkerHealthServer } from "../server.js";

export interface WorkerRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createWorkerRuntime(options: {
  healthServer: WorkerHealthServer;
  healthHost: string;
  healthPort: number;
  orderProcessConsumer: OrderProcessConsumer;
  logger: CheckoutSurgeLogger;
}): WorkerRuntime {
  let started = false;
  let closePromise: Promise<void> | null = null;

  return {
    async start() {
      if (started) {
        return;
      }

      options.orderProcessConsumer.start();

      try {
        await options.healthServer.listen({
          host: options.healthHost,
          port: options.healthPort,
          listenTextResolver: (address) => `Worker health server listening at ${address}`,
        });
        started = true;
      } catch (error) {
        await options.orderProcessConsumer.close();
        throw error;
      }
    },
    close() {
      closePromise ??= (async () => {
        options.logger.info("Closing worker runtime.");
        await options.healthServer.close();
        await options.orderProcessConsumer.close();
        started = false;
      })();

      return closePromise;
    },
  };
}
