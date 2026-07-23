import { describe, expect, it, vi } from "vitest";
import {
  closeApiResources,
  createOperationResourceCleanup,
  runWithResourceCleanup,
} from "../src/runtime/api-resource-cleanup.js";

describe("API resource cleanup", () => {
  it("runs abort-triggered operation cleanup once and aggregates every failure", async () => {
    const firstError = new Error("first close failed");
    const secondError = new Error("second close failed");
    const first = vi.fn().mockRejectedValue(firstError);
    const second = vi.fn().mockRejectedValue(secondError);
    const controller = new AbortController();
    const close = createOperationResourceCleanup({
      signal: controller.signal,
      operations: [first, second],
      failureMessage: "Operation cleanup failed.",
    });

    controller.abort(new Error("timed out"));

    await expect(close()).rejects.toMatchObject({ errors: [firstError, secondError] });
    await expect(close()).rejects.toMatchObject({ errors: [firstError, secondError] });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("preserves both operation and cleanup failures", async () => {
    const operationError = new Error("operation failed");
    const cleanupError = new Error("cleanup failed");

    await expect(
      runWithResourceCleanup(
        async () => {
          throw operationError;
        },
        async () => {
          throw cleanupError;
        },
        "Operation and cleanup failed.",
      ),
    ).rejects.toMatchObject({ errors: [operationError, cleanupError] });
  });

  it("closes recovery admission, then drains the server before request dependencies", async () => {
    let recoveryClosed = false;
    const closePendingPersistenceRecovery = vi.fn(async () => {
      recoveryClosed = true;
    });
    let readinessClosed = false;
    const closeReadiness = vi.fn(async () => {
      expect(recoveryClosed).toBe(true);
      readinessClosed = true;
    });
    let serverClosed = false;
    const closeServer = vi.fn(async () => {
      expect(recoveryClosed).toBe(true);
      expect(readinessClosed).toBe(true);
      await Promise.resolve();
      serverClosed = true;
    });
    const closeOrderProcessJobPublisher = vi.fn(async () => {
      expect(serverClosed).toBe(true);
    });
    const closeDashboardPublicationScheduler = vi.fn(async () => {
      expect(serverClosed).toBe(true);
    });
    const closeBusinessOutcomePublicationScheduler = vi.fn(async () => undefined);
    const closeDashboardProjectionDirtySubscriber = vi.fn(async () => {
      expect(serverClosed).toBe(true);
    });
    const closeOrderProcessQueueInspector = vi.fn(async () => {
      expect(serverClosed).toBe(true);
    });
    const closeDemoQueueMaintenance = vi.fn(async () => {
      expect(serverClosed).toBe(true);
    });
    const disconnectRedis = vi.fn(() => {
      expect(serverClosed).toBe(true);
    });
    const closeDatabase = vi.fn(async () => {
      expect(serverClosed).toBe(true);
    });

    await closeApiResources({
      closePendingPersistenceRecovery,
      closeReadiness,
      closeServer,
      closeDashboardPublicationScheduler,
      closeBusinessOutcomePublicationScheduler,
      closeDashboardProjectionDirtySubscriber,
      closeOrderProcessJobPublisher,
      closeOrderProcessQueueInspector,
      closeDemoQueueMaintenance,
      disconnectRedis,
      closeDatabase,
    });

    expect(closePendingPersistenceRecovery).toHaveBeenCalledOnce();
    expect(closeReadiness).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(closeDashboardPublicationScheduler).toHaveBeenCalledOnce();
    expect(closeBusinessOutcomePublicationScheduler).toHaveBeenCalledOnce();
    expect(closeDashboardProjectionDirtySubscriber).toHaveBeenCalledOnce();
    expect(closeOrderProcessJobPublisher).toHaveBeenCalledOnce();
    expect(closeOrderProcessQueueInspector).toHaveBeenCalledOnce();
    expect(closeDemoQueueMaintenance).toHaveBeenCalledOnce();
    expect(disconnectRedis).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("attempts every dependency cleanup and aggregates all failures after server close fails", async () => {
    const serverError = new Error("server close failed");
    const pendingRecoveryError = new Error("pending recovery close failed");
    const subscriberError = new Error("subscriber close failed");
    const schedulerError = new Error("scheduler close failed");
    const publisherError = new Error("publisher close failed");
    const inspectorError = new Error("inspector close failed");
    const maintenanceError = new Error("maintenance close failed");
    const redisError = new Error("Redis disconnect failed");
    const databaseError = new Error("database close failed");
    const closeServer = vi.fn().mockRejectedValue(serverError);
    const closePendingPersistenceRecovery = vi.fn().mockRejectedValue(pendingRecoveryError);
    const readinessError = new Error("readiness close failed");
    const closeReadiness = vi.fn().mockRejectedValue(readinessError);
    const closeDashboardProjectionDirtySubscriber = vi.fn().mockRejectedValue(subscriberError);
    const closeDashboardPublicationScheduler = vi.fn().mockRejectedValue(schedulerError);
    const closeBusinessOutcomePublicationScheduler = vi.fn(async () => undefined);
    const closeOrderProcessJobPublisher = vi.fn().mockRejectedValue(publisherError);
    const closeOrderProcessQueueInspector = vi.fn().mockRejectedValue(inspectorError);
    const closeDemoQueueMaintenance = vi.fn().mockRejectedValue(maintenanceError);
    const disconnectRedis = vi.fn(() => {
      throw redisError;
    });
    const closeDatabase = vi.fn().mockRejectedValue(databaseError);
    let cleanupError: unknown;

    try {
      await closeApiResources({
        closePendingPersistenceRecovery,
        closeReadiness,
        closeServer,
        closeDashboardPublicationScheduler,
        closeBusinessOutcomePublicationScheduler,
        closeDashboardProjectionDirtySubscriber,
        closeOrderProcessJobPublisher,
        closeOrderProcessQueueInspector,
        closeDemoQueueMaintenance,
        disconnectRedis,
        closeDatabase,
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toEqual([
      pendingRecoveryError,
      readinessError,
      serverError,
      schedulerError,
      subscriberError,
      publisherError,
      inspectorError,
      maintenanceError,
      redisError,
      databaseError,
    ]);
    expect(closePendingPersistenceRecovery).toHaveBeenCalledOnce();
    expect(closeReadiness).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(closeDashboardPublicationScheduler).toHaveBeenCalledOnce();
    expect(closeDashboardProjectionDirtySubscriber).toHaveBeenCalledOnce();
    expect(closeOrderProcessJobPublisher).toHaveBeenCalledOnce();
    expect(closeOrderProcessQueueInspector).toHaveBeenCalledOnce();
    expect(closeDemoQueueMaintenance).toHaveBeenCalledOnce();
    expect(disconnectRedis).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
