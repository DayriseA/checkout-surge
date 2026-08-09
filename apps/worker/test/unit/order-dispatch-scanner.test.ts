import type { OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { createOrderDispatchScanner } from "../../src/application/order-dispatch-scanner.js";

const jobs: OrderProcessJob[] = [
  {
    orderId: "11111111-1111-4111-8111-111111111111",
    publicOrderId: "ord_dispatch_1",
    reservationId: "33333333-3333-4333-8333-333333333333",
    saleOfferId: "22222222-2222-4222-8222-222222222222",
    correlationId: "corr-dispatch-1",
    quantity: 1,
    queuedAt: "2026-06-21T00:00:00.000Z",
  },
  {
    orderId: "11111111-1111-4111-8111-111111111112",
    publicOrderId: "ord_dispatch_2",
    reservationId: "33333333-3333-4333-8333-333333333334",
    saleOfferId: "22222222-2222-4222-8222-222222222222",
    correlationId: "corr-dispatch-2",
    quantity: 2,
    queuedAt: "2026-06-21T00:00:01.000Z",
  },
];

describe("order dispatch scanner", () => {
  it("publishes every candidate, isolates failures, and retries on later scans", async () => {
    const publishError = new Error("queue unavailable");
    const persistence = {
      findQueuedOrdersForDispatch: vi.fn().mockResolvedValue(jobs),
    };
    const publisher = {
      enqueue: vi.fn().mockRejectedValueOnce(publishError).mockResolvedValue(undefined),
    };
    const logger = createSilentLogger("worker");
    const logError = vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    const scanner = createOrderDispatchScanner({
      persistence,
      publisher,
      logger,
      scanIntervalMs: 1000,
      batchSize: 25,
      minimumQueuedAgeMs: 5000,
      now: () => new Date("2026-06-21T00:00:10.000Z"),
    });

    await expect(scanner.scanOnce()).resolves.toEqual({ candidates: 2, published: 1, failed: 1 });
    await expect(scanner.scanOnce()).resolves.toEqual({ candidates: 2, published: 2, failed: 0 });

    expect(persistence.findQueuedOrdersForDispatch).toHaveBeenCalledWith({
      queuedBefore: new Date("2026-06-21T00:00:05.000Z"),
      limit: 25,
    });
    expect(publisher.enqueue).toHaveBeenCalledTimes(4);
    expect(logError).toHaveBeenCalledWith(
      {
        err: publishError,
        orderId: jobs[0]?.orderId,
        saleOfferId: jobs[0]?.saleOfferId,
        correlationId: jobs[0]?.correlationId,
      },
      "Order dispatch recovery could not publish an order-processing job.",
    );
  });

  it("does not overlap scheduled scans and waits for in-flight work on close", async () => {
    let resolveScan: (() => void) | undefined;
    const scanFinished = new Promise<void>((resolve) => {
      resolveScan = resolve;
    });
    const persistence = {
      findQueuedOrdersForDispatch: vi.fn().mockImplementation(() => scanFinished.then(() => [])),
    };
    const scanner = createOrderDispatchScanner({
      persistence,
      publisher: { enqueue: vi.fn() },
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1,
      batchSize: 10,
      minimumQueuedAgeMs: 0,
    });

    scanner.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(persistence.findQueuedOrdersForDispatch).toHaveBeenCalledOnce();

    const closePromise = scanner.close();
    let closed = false;
    void closePromise.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolveScan?.();
    await closePromise;
    expect(closed).toBe(true);
  });
});
