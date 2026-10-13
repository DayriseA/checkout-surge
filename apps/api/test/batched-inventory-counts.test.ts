import {
  applyInventoryCountBatch,
  createRedisClient,
  getInventoryStatus,
  initializeInventory,
  setRunSaleEligibility,
} from "@checkout-surge/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BatchedInventoryCounts } from "../src/services/batched-inventory-counts.js";

const runId = "30000000-0000-4000-8000-000000000001";
const saleOfferId = "30000000-0000-4000-8000-000000000002";

function testRedisUrl(): string {
  if (!process.env.TEST_REDIS_URL) throw new Error("TEST_REDIS_URL is required.");
  return process.env.TEST_REDIS_URL;
}

describe("batched live counters when PostgreSQL decides the stock", () => {
  const redis = createRedisClient(testRedisUrl(), { maxRetriesPerRequest: 3 });
  const errors: unknown[] = [];
  const counts = new BatchedInventoryCounts({
    apply: (batch) => applyInventoryCountBatch(redis, batch),
    onError: (error) => errors.push(error),
    flushIntervalMs: 60_000,
  });

  beforeEach(async () => {
    await redis.flushdb();
    errors.length = 0;
    await initializeInventory(redis, {
      saleOfferId,
      allocatedStock: 3,
      run: { runId, status: "accepting" },
    });
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("adds a process's answers to the run's live counters in one batch", async () => {
    const at = new Date();
    counts.recordReserved({ runId, saleOfferId, quantity: 1, reservedAt: at });
    counts.recordReserved({ runId, saleOfferId, quantity: 1, reservedAt: at });
    for (let index = 0; index < 5; index += 1) {
      counts.recordSoldOut({ runId, saleOfferId, observedAt: at });
    }
    await counts.flush();

    const status = await getInventoryStatus(redis, saleOfferId, at);
    expect(status).toMatchObject({ remainingStock: 1, reservedStock: 2 });
    expect(status.soldOutPressure).toEqual({
      rejectionCount: 5,
      latestObservedAt: at.toISOString(),
    });
    expect(status.reservationThroughput.successfulReservationCount).toBe(2);
    expect(errors).toEqual([]);
  });

  it("counts nothing once the run's sale is closed, so its final counters stay final", async () => {
    await setRunSaleEligibility(redis, { runId, saleOfferId, status: "closed" });
    counts.recordSoldOut({ runId, saleOfferId, observedAt: new Date() });
    await counts.flush();

    const status = await getInventoryStatus(redis, saleOfferId);
    expect(status.soldOutPressure.rejectionCount).toBe(0);
    expect(errors).toEqual([]);
  });
});
