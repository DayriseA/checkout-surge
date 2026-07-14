import { describe, expect, it, vi } from "vitest";
import { closeApiResources } from "../src/runtime/api-resource-cleanup.js";

describe("API resource cleanup", () => {
  it("drains the server before closing request dependencies", async () => {
    let serverClosed = false;
    const closeServer = vi.fn(async () => {
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
    const closeDashboardEventSubscriber = vi.fn(async () => {
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
      closeServer,
      closeDashboardPublicationScheduler,
      closeBusinessOutcomePublicationScheduler,
      closeDashboardEventSubscriber,
      closeOrderProcessJobPublisher,
      closeOrderProcessQueueInspector,
      closeDemoQueueMaintenance,
      disconnectRedis,
      closeDatabase,
    });

    expect(closeServer).toHaveBeenCalledOnce();
    expect(closeDashboardPublicationScheduler).toHaveBeenCalledOnce();
    expect(closeBusinessOutcomePublicationScheduler).toHaveBeenCalledOnce();
    expect(closeDashboardEventSubscriber).toHaveBeenCalledOnce();
    expect(closeOrderProcessJobPublisher).toHaveBeenCalledOnce();
    expect(closeOrderProcessQueueInspector).toHaveBeenCalledOnce();
    expect(closeDemoQueueMaintenance).toHaveBeenCalledOnce();
    expect(disconnectRedis).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("attempts every dependency cleanup and aggregates all failures after server close fails", async () => {
    const serverError = new Error("server close failed");
    const subscriberError = new Error("subscriber close failed");
    const schedulerError = new Error("scheduler close failed");
    const publisherError = new Error("publisher close failed");
    const inspectorError = new Error("inspector close failed");
    const maintenanceError = new Error("maintenance close failed");
    const redisError = new Error("Redis disconnect failed");
    const databaseError = new Error("database close failed");
    const closeServer = vi.fn().mockRejectedValue(serverError);
    const closeDashboardEventSubscriber = vi.fn().mockRejectedValue(subscriberError);
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
        closeServer,
        closeDashboardPublicationScheduler,
        closeBusinessOutcomePublicationScheduler,
        closeDashboardEventSubscriber,
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
      serverError,
      schedulerError,
      subscriberError,
      publisherError,
      inspectorError,
      maintenanceError,
      redisError,
      databaseError,
    ]);
    expect(closeServer).toHaveBeenCalledOnce();
    expect(closeDashboardPublicationScheduler).toHaveBeenCalledOnce();
    expect(closeDashboardEventSubscriber).toHaveBeenCalledOnce();
    expect(closeOrderProcessJobPublisher).toHaveBeenCalledOnce();
    expect(closeOrderProcessQueueInspector).toHaveBeenCalledOnce();
    expect(closeDemoQueueMaintenance).toHaveBeenCalledOnce();
    expect(disconnectRedis).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
