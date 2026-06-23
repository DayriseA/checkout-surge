import type { ReadinessCheck } from "@checkout-surge/contracts";
import type { SqlClient } from "@checkout-surge/db";
import { createReadinessCheck } from "@checkout-surge/logger";
import type { Redis } from "ioredis";
import type { NotificationRecordConsumer } from "../queue/notification-record-consumer.js";
import type { OrderProcessConsumer } from "../queue/order-process-consumer.js";

export interface WorkerReadiness {
  checks(): Promise<ReadinessCheck[]>;
}

export function createWorkerReadiness(dependencies: {
  postgres: SqlClient;
  redis: Redis;
  orderProcessConsumer: OrderProcessConsumer;
  notificationRecordConsumer: NotificationRecordConsumer;
}): WorkerReadiness {
  return {
    checks: async () => {
      const checks: ReadinessCheck[] = [];

      try {
        await dependencies.postgres.unsafe("SELECT 1");
        checks.push(createReadinessCheck({ name: "database_reachable", status: "ok" }));
      } catch (error) {
        checks.push(
          createReadinessCheck({
            name: "database_reachable",
            status: "unavailable",
            message: error instanceof Error ? error.message : "PostgreSQL check failed.",
          }),
        );
      }

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

      try {
        await dependencies.orderProcessConsumer.checkConnectivity();
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

      const isNotificationConsumerRunning = dependencies.notificationRecordConsumer.isRunning();
      checks.push(
        createReadinessCheck({
          name: "notification_record_worker_running",
          status: isNotificationConsumerRunning ? "ok" : "unavailable",
          ...(!isNotificationConsumerRunning
            ? { message: "The notification-recording consumer is not running." }
            : {}),
        }),
      );

      try {
        await dependencies.notificationRecordConsumer.checkConnectivity();
        checks.push(
          createReadinessCheck({ name: "notification_record_queue_reachable", status: "ok" }),
        );
      } catch (error) {
        checks.push(
          createReadinessCheck({
            name: "notification_record_queue_reachable",
            status: "unavailable",
            message: error instanceof Error ? error.message : "Queue check failed.",
          }),
        );
      }

      return checks;
    },
  };
}
