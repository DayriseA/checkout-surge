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
    const closeOrderProcessQueueInspector = vi.fn(async () => {
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
      closeOrderProcessJobPublisher,
      closeOrderProcessQueueInspector,
      disconnectRedis,
      closeDatabase,
    });

    expect(closeServer).toHaveBeenCalledOnce();
    expect(closeOrderProcessJobPublisher).toHaveBeenCalledOnce();
    expect(closeOrderProcessQueueInspector).toHaveBeenCalledOnce();
    expect(disconnectRedis).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("attempts every dependency cleanup and aggregates all failures after server close fails", async () => {
    const serverError = new Error("server close failed");
    const publisherError = new Error("publisher close failed");
    const inspectorError = new Error("inspector close failed");
    const redisError = new Error("Redis disconnect failed");
    const databaseError = new Error("database close failed");
    const closeServer = vi.fn().mockRejectedValue(serverError);
    const closeOrderProcessJobPublisher = vi.fn().mockRejectedValue(publisherError);
    const closeOrderProcessQueueInspector = vi.fn().mockRejectedValue(inspectorError);
    const disconnectRedis = vi.fn(() => {
      throw redisError;
    });
    const closeDatabase = vi.fn().mockRejectedValue(databaseError);
    let cleanupError: unknown;

    try {
      await closeApiResources({
        closeServer,
        closeOrderProcessJobPublisher,
        closeOrderProcessQueueInspector,
        disconnectRedis,
        closeDatabase,
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect((cleanupError as AggregateError).errors).toEqual([
      serverError,
      publisherError,
      inspectorError,
      redisError,
      databaseError,
    ]);
    expect(closeServer).toHaveBeenCalledOnce();
    expect(closeOrderProcessJobPublisher).toHaveBeenCalledOnce();
    expect(closeOrderProcessQueueInspector).toHaveBeenCalledOnce();
    expect(disconnectRedis).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
