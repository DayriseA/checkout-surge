import { randomUUID } from "node:crypto";
import {
  controlServiceTokenHeaderName,
  emptyServerReservationTimingSummary,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerBuyerTimingFlushRoute,
  registerPendingRecoveryRoute,
} from "../../src/routes/api-peer-routes.js";
import { buildApiHttpServer } from "../../src/runtime/api-http-server.js";
import { buildBuyerApiServer } from "../../src/runtime/buyer-api-runtime.js";
import { loadApiConfig } from "../../src/runtime/config.js";
import type { ApiFastifyInstance } from "../../src/runtime/fastify.js";
import { buyerTimingFlushPath, pendingRecoveryPath } from "../../src/services/api-peer-protocol.js";
import { BuyerRequestDrain } from "../../src/services/buyer-request-drain.js";
import { BuyerReservationTimingBarrier } from "../../src/services/buyer-reservation-timing-barrier.js";
import { HttpPendingPersistenceRecovery } from "../../src/services/http-pending-persistence-recovery.js";
import { ReservationTimingObservationScheduler } from "../../src/services/reservation-timing-observation.js";

const config = loadApiConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  CONTROL_SERVICE_TOKEN: "test-control-token",
  PUBLIC_CLIENT_COOKIE_SECRET: "test-public-cookie-secret",
});
const logger = createSilentLogger("api");
const servers: ApiFastifyInstance[] = [];
const runId = randomUUID();
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("API peer boundaries", () => {
  it("exposes only health, buy, and authenticated timing flush on a buyer", async () => {
    const flush = vi.fn(async () => ({ bootId: randomUUID(), mergeFailureGeneration: 0 }));
    const server = await buildBuyerApiServer({
      config,
      logger,
      readiness: { checks: async () => [], close: async () => undefined },
      reserveOrderService: { reserve: vi.fn() },
      flush,
    });
    servers.push(server);
    expect((await server.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    for (const [method, url] of [
      ["POST", "/demo/runs/start"],
      ["POST", "/internal/reservations/recover"],
      ["POST", "/admin/demo/reset"],
      ["GET", "/dashboard/recovery"],
      ["GET", "/dashboard/events"],
      ["GET", "/core/idle-status"],
    ] as const) {
      expect((await server.inject({ method, url })).statusCode).toBe(404);
    }
    expect(
      (await server.inject({ method: "POST", url: buyerTimingFlushPath, payload: { runId } }))
        .statusCode,
    ).toBe(401);
    expect(flush).not.toHaveBeenCalled();
    expect(
      (
        await server.inject({
          method: "POST",
          url: buyerTimingFlushPath,
          headers: { [controlServiceTokenHeaderName]: config.controlServiceToken },
          payload: { runId: "bad" },
        })
      ).statusCode,
    ).toBe(400);
    expect(flush).not.toHaveBeenCalled();
    expect(
      (
        await server.inject({
          method: "POST",
          url: buyerTimingFlushPath,
          headers: { [controlServiceTokenHeaderName]: config.controlServiceToken },
          payload: { runId },
        })
      ).statusCode,
    ).toBe(200);
    expect(flush).toHaveBeenCalledWith(runId);
  });

  it("authenticates and validates direct recovery before calling the sole owner", async () => {
    const server = await buildApiHttpServer({ config, logger });
    servers.push(server);
    const recoverReservation = vi.fn(async () => null);
    registerPendingRecoveryRoute(server, {
      controlServiceToken: config.controlServiceToken,
      recovery: { recoverReservation },
    });
    expect(
      (await server.inject({ method: "POST", url: pendingRecoveryPath, payload: {} })).statusCode,
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: "POST",
          url: pendingRecoveryPath,
          headers: { [controlServiceTokenHeaderName]: config.controlServiceToken },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(recoverReservation).not.toHaveBeenCalled();
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const recovery = new HttpPendingPersistenceRecovery({
      baseUrl,
      controlServiceToken: config.controlServiceToken,
    });
    const input = {
      idempotencyKey: "peer-pending-retry",
      reservation: {
        id: randomUUID(),
        runId,
        saleOfferId: randomUUID(),
        quantity: 1,
        reservationToken: "peer-reservation-token",
        correlationId: "peer-retry",
        securedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    expect(await recovery.recoverReservation(input)).toBeNull();
    expect(recoverReservation).toHaveBeenCalledWith(input);
  });

  it("waits for in-flight service observations before flushing", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<never>((_resolve, reject) => {
      finish = () => reject(new Error("interrupted request"));
    });
    const drain = new BuyerRequestDrain({ reserve: () => pending });
    const request = drain.reserve({
      request: { runId, saleOfferId: randomUUID(), quantity: 1, idempotencyKey: "drain-test" },
      correlationId: "drain",
    });
    const settled = vi.fn();
    const drained = drain.drain(runId).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    finish?.();
    await expect(request).rejects.toThrow("interrupted request");
    await drained;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("returns unknown timings when a buyer restarts, fails a flush, or has no baseline", async () => {
    const server = await buildApiHttpServer({ config, logger });
    servers.push(server);
    let bootId = randomUUID();
    let mergeFailureGeneration = 0;
    registerBuyerTimingFlushRoute(server, {
      controlServiceToken: config.controlServiceToken,
      flush: async () => ({ bootId, mergeFailureGeneration }),
    });
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const summary = {
      redisAtomicReservation: { sampleCount: 1, averageMs: 2, p95Ms: 2 },
      reserveOrderService: { sampleCount: 1, averageMs: 3, p95Ms: 3 },
    };
    const local = {
      readAndFence: vi.fn(async () => summary),
      clearRun: vi.fn(async () => undefined),
    };
    const barrier = new BuyerReservationTimingBarrier({
      buyerBaseUrls: [baseUrl],
      controlServiceToken: config.controlServiceToken,
      local,
      logger,
    });
    await barrier.captureBaseline(runId);
    await barrier.prepare(runId);
    expect(await barrier.readAndFence(runId)).toEqual(summary);
    bootId = randomUUID();
    await barrier.prepare(runId);
    expect(await barrier.readAndFence(runId)).toEqual(emptyServerReservationTimingSummary);
    await barrier.captureBaseline(runId);
    mergeFailureGeneration += 1;
    await barrier.prepare(runId);
    expect(await barrier.readAndFence(runId)).toEqual(emptyServerReservationTimingSummary);
    await barrier.clearRun(runId);
    mergeFailureGeneration += 1;
    await barrier.prepare(runId);
    expect(await barrier.readAndFence(runId)).toEqual(emptyServerReservationTimingSummary);
    await barrier.captureBaseline(runId);
    await server.close();
    await barrier.prepare(runId);
    expect(await barrier.readAndFence(runId)).toEqual(emptyServerReservationTimingSummary);
    expect(local.readAndFence).toHaveBeenCalledTimes(5);
  });

  it("retires prior completed and startup-failed timing state when another run is accepted", async () => {
    const server = await buildApiHttpServer({ config, logger });
    servers.push(server);
    const bootId = randomUUID();
    let unavailable = false;
    registerBuyerTimingFlushRoute(server, {
      controlServiceToken: config.controlServiceToken,
      flush: async () => {
        if (unavailable) throw new Error("Buyer unavailable during startup.");
        return { bootId, mergeFailureGeneration: 0 };
      },
    });
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const summary = {
      redisAtomicReservation: { sampleCount: 1, averageMs: 2, p95Ms: 2 },
      reserveOrderService: { sampleCount: 1, averageMs: 3, p95Ms: 3 },
    };
    const barrier = new BuyerReservationTimingBarrier({
      buyerBaseUrls: [baseUrl],
      controlServiceToken: config.controlServiceToken,
      local: { readAndFence: async () => summary, clearRun: async () => undefined },
      logger,
    });
    for (let index = 0; index < 6; index += 1) {
      const completedRun = randomUUID();
      await barrier.captureBaseline(completedRun);
      await barrier.prepare(completedRun);
      expect(await barrier.readAndFence(completedRun)).toEqual(summary);

      // A durable acceptance can fail before dispatch. The following acceptance
      // must retire both that missing baseline and the prior completed evidence.
      const startupFailedRun = randomUUID();
      unavailable = true;
      await barrier.captureBaseline(startupFailedRun);
      expect(await barrier.readAndFence(completedRun)).toEqual(emptyServerReservationTimingSummary);
      unavailable = false;
      const nextRun = randomUUID();
      await barrier.captureBaseline(nextRun);
      await barrier.clearRun(startupFailedRun);
      await barrier.prepare(nextRun);
      expect(await barrier.readAndFence(nextRun)).toEqual(summary);
      expect(await barrier.readAndFence(startupFailedRun)).toEqual(
        emptyServerReservationTimingSummary,
      );
    }
  });

  it("keeps observed timing loss unknown through older flushes and an in-flight fence", async () => {
    let releaseOlderFlush!: () => void;
    const olderFlushPending = new Promise<void>((resolve) => {
      releaseOlderFlush = resolve;
    });
    let markOlderFlushStarted!: () => void;
    const olderFlushStarted = new Promise<void>((resolve) => {
      markOlderFlushStarted = resolve;
    });
    let releaseFence!: () => void;
    const fencePending = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const server = await buildApiHttpServer({ config, logger });
    servers.push(server);
    const bootId = randomUUID();
    let mergeFailureGeneration = 0;
    let flushCount = 0;
    registerBuyerTimingFlushRoute(server, {
      controlServiceToken: config.controlServiceToken,
      flush: async () => {
        const response = { bootId, mergeFailureGeneration };
        flushCount += 1;
        if (flushCount === 3) {
          markOlderFlushStarted();
          await olderFlushPending;
        }
        return response;
      },
    });
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const summary = {
      redisAtomicReservation: { sampleCount: 1, averageMs: 2, p95Ms: 2 },
      reserveOrderService: { sampleCount: 1, averageMs: 3, p95Ms: 3 },
    };
    const readAndFence = vi
      .fn(async () => summary)
      .mockImplementationOnce(async () => {
        await fencePending;
        return summary;
      });
    const barrier = new BuyerReservationTimingBarrier({
      buyerBaseUrls: [baseUrl],
      controlServiceToken: config.controlServiceToken,
      local: { readAndFence, clearRun: async () => undefined },
      logger,
    });
    await barrier.captureBaseline(runId);
    await barrier.prepare(runId);
    const olderPrepare = barrier.prepare(runId);
    await olderFlushStarted;
    const reading = barrier.readAndFence(runId);
    expect(readAndFence).toHaveBeenCalledOnce();
    try {
      mergeFailureGeneration += 1;
      await barrier.prepare(runId);
      releaseOlderFlush();
      await olderPrepare;
      releaseFence();
      expect(await reading).toEqual(emptyServerReservationTimingSummary);
      expect(await barrier.readAndFence(runId)).toEqual(emptyServerReservationTimingSummary);

      const nextRun = randomUUID();
      await barrier.captureBaseline(nextRun);
      await barrier.prepare(nextRun);
      expect(await barrier.readAndFence(nextRun)).toEqual(summary);
    } finally {
      releaseOlderFlush();
      releaseFence();
      await Promise.all([olderPrepare, reading]);
    }
  });

  it("keeps lost timing samples unknown across retries but permits clean later runs", async () => {
    const summary = {
      redisAtomicReservation: { sampleCount: 1, averageMs: 2, p95Ms: 2 },
      reserveOrderService: { sampleCount: 1, averageMs: 3, p95Ms: 3 },
    };
    const mergeIfLive = vi.fn(async () => true);
    const timing = new ReservationTimingObservationScheduler(
      { mergeIfLive, readAndFence: async () => summary, clearRun: async () => undefined },
      logger,
    );
    const server = await buildApiHttpServer({ config, logger });
    servers.push(server);
    const bootId = randomUUID();
    registerBuyerTimingFlushRoute(server, {
      controlServiceToken: config.controlServiceToken,
      flush: async () => ({
        bootId,
        mergeFailureGeneration: await timing.flushAndReadFailureGeneration(),
      }),
    });
    const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const barrier = new BuyerReservationTimingBarrier({
      buyerBaseUrls: [baseUrl],
      controlServiceToken: config.controlServiceToken,
      local: timing,
      logger,
    });
    try {
      await barrier.captureBaseline(runId);
      mergeIfLive.mockRejectedValueOnce(new Error("Timing Redis merge failed."));
      timing.observe({ runId, reserveOrderServiceMs: 3 });
      await barrier.prepare(runId);
      expect(await barrier.readAndFence(runId)).toEqual(emptyServerReservationTimingSummary);
      await barrier.prepare(runId);
      expect(await barrier.readAndFence(runId)).toEqual(emptyServerReservationTimingSummary);
      expect(await timing.flushAndReadFailureGeneration()).toBe(1);

      const nextRun = randomUUID();
      await barrier.captureBaseline(nextRun);
      timing.observe({ runId: nextRun, reserveOrderServiceMs: 3 });
      await barrier.prepare(nextRun);
      expect(await barrier.readAndFence(nextRun)).toEqual(summary);
      expect(await timing.flushAndReadFailureGeneration()).toBe(1);
    } finally {
      await timing.close();
    }
  });
});
