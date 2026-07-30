import { emptyServerReservationTimingSummary } from "@checkout-surge/contracts";
import { createRedisClient } from "@checkout-surge/db";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RedisReservationTimingStore,
  ReservationTimingObservationScheduler,
  type ReservationTimingStore,
} from "../src/services/reservation-timing-observation.js";

const runId = "55555555-5555-4555-8555-555555555555";

describe("reservation timing observation", () => {
  it("batches bounded histogram counters before fencing the terminal snapshot", async () => {
    const mergeIfLive = vi.fn<ReservationTimingStore["mergeIfLive"]>(async () => true);
    const readAndFence = vi.fn<ReservationTimingStore["readAndFence"]>(
      async () => emptyServerReservationTimingSummary,
    );
    const store: ReservationTimingStore = {
      mergeIfLive,
      readAndFence,
      clearRun: async () => undefined,
    };
    const scheduler = new ReservationTimingObservationScheduler(store, createSilentLogger("api"));

    scheduler.observe({
      runId,
      redisAtomicReservationMs: 0.8,
      reserveOrderServiceMs: 12,
    });
    scheduler.observe({
      runId,
      redisAtomicReservationMs: 2,
      reserveOrderServiceMs: 80,
    });

    await scheduler.readAndFence(runId);

    expect(mergeIfLive).toHaveBeenCalledOnce();
    const aggregate = mergeIfLive.mock.calls[0]?.[1];
    expect(aggregate?.redisAtomicReservation).toMatchObject({
      count: 2,
      sumMs: 2.8,
      maxMs: 2,
    });
    expect(aggregate?.redisAtomicReservation.buckets.reduce(sum, 0)).toBe(2);
    expect(aggregate?.reserveOrderService).toMatchObject({
      count: 2,
      sumMs: 92,
      maxMs: 80,
    });
    expect(aggregate?.reserveOrderService.buckets.reduce(sum, 0)).toBe(2);
    expect(readAndFence).toHaveBeenCalledAfter(mergeIfLive);
  });

  it("logs observations dropped after a terminal fence", async () => {
    const logger = createSilentLogger("api");
    const debug = vi.spyOn(logger, "debug");
    const store: ReservationTimingStore = {
      mergeIfLive: async () => false,
      readAndFence: async () => emptyServerReservationTimingSummary,
      clearRun: async () => undefined,
    };
    const scheduler = new ReservationTimingObservationScheduler(store, logger);

    scheduler.observe({ runId, redisAtomicReservationMs: 1, reserveOrderServiceMs: 2 });
    await scheduler.close();

    expect(debug).toHaveBeenCalledWith(
      { droppedSampleCount: 1, runId },
      "Dropped reservation timing observations after the terminal fence.",
    );
  });
});

describe("Redis reservation timing store", () => {
  const redis = createRedisClient(requireTestRedisUrl(), {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });
  const store = new RedisReservationTimingStore(redis);

  beforeEach(async () => redis.flushdb());
  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("merges Lua histogram buckets, derives their p95 bounds, and fences late samples", async () => {
    const merged = await store.mergeIfLive(runId, {
      redisAtomicReservation: {
        count: 20,
        sumMs: 70_001,
        maxMs: 70_000,
        buckets: [18, 1, ...Array.from({ length: 16 }, () => 0), 1],
      },
      reserveOrderService: {
        count: 20,
        sumMs: 71_900,
        maxMs: 70_000,
        buckets: [
          ...Array.from({ length: 11 }, () => 0),
          19,
          ...Array.from({ length: 6 }, () => 0),
          1,
        ],
      },
    });

    expect(merged).toBe(true);
    await expect(store.readAndFence(runId)).resolves.toEqual({
      redisAtomicReservation: { sampleCount: 20, averageMs: 3500.05, p95Ms: 0.5 },
      reserveOrderService: { sampleCount: 20, averageMs: 3595, p95Ms: 500 },
    });
    await expect(
      store.mergeIfLive(runId, {
        redisAtomicReservation: {
          count: 1,
          sumMs: 1,
          maxMs: 1,
          buckets: [0, 0, 0, 1, ...Array.from({ length: 15 }, () => 0)],
        },
        reserveOrderService: {
          count: 1,
          sumMs: 2,
          maxMs: 2,
          buckets: [0, 0, 0, 0, 1, ...Array.from({ length: 14 }, () => 0)],
        },
      }),
    ).resolves.toBe(false);
  });
});

function sum(total: number, value: number): number {
  return total + value;
}

function requireTestRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) throw new Error("TEST_REDIS_URL is required for reservation timing tests.");
  return value;
}
