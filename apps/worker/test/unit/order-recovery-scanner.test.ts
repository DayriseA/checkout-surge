import type { OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  createOrderRecoveryScanner,
  type OrderRecoveryPersistence,
} from "../../src/application/order-recovery-scanner.js";

const job: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_recovery",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  correlationId: "corr-recovery",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
};

function persistence(overrides: Partial<OrderRecoveryPersistence> = {}): OrderRecoveryPersistence {
  return {
    recordRecoverable: vi.fn(),
    findRecoverable: vi.fn().mockResolvedValue([
      {
        recoveryKey: "order:11111111-1111-4111-8111-111111111111",
        job,
        reason: "accepted_result_incomplete",
        attempts: 1,
        createdAt: new Date("2026-06-21T00:00:00.000Z"),
      },
    ]),
    markEnqueued: vi.fn(),
    markEscalated: vi.fn(),
    recordDeadLetter: vi.fn(),
    ...overrides,
  };
}

describe("order recovery scanner", () => {
  it("publishes attempt-scoped deterministic IDs and claims durable attempts", async () => {
    const store = persistence({
      claimForPublication: vi.fn().mockResolvedValue({ attempt: 2 }),
      markPublicationFailed: vi.fn(),
    });
    const publisher = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      now: () => new Date("2026-06-22T00:00:10.000Z"),
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ candidates: 1, enqueued: 1 });
    expect(publisher.enqueue).toHaveBeenCalledWith(job, {
      jobId: "recovery-11111111-1111-4111-8111-111111111111-2",
      attempts: 1,
    });
    expect(store.claimForPublication).toHaveBeenCalledOnce();
  });

  it("escalates instead of publishing after the recovery budget", async () => {
    const store = persistence({
      findRecoverable: vi.fn().mockResolvedValue([
        {
          recoveryKey: "order:key",
          job,
          reason: "persist",
          attempts: 3,
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
        },
      ]),
    });
    const publisher = { enqueue: vi.fn() };
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      maxRecoveryAttempts: 3,
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ escalated: 1, enqueued: 0 });
    expect(store.markEscalated).toHaveBeenCalledWith({
      recoveryKey: "order:key",
      error: "recovery_attempt_limit_exceeded",
    });
    expect(publisher.enqueue).not.toHaveBeenCalled();
  });

  it("ingests one failed BullMQ disposition without resetting an active claim on rescans", async () => {
    const claimForPublication = vi
      .fn()
      .mockResolvedValueOnce({ attempt: 1 })
      .mockResolvedValueOnce(null);
    const store = persistence({ claimForPublication, markPublicationFailed: vi.fn() });
    const publisher = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const reader = {
      findFailedOrderJobs: vi.fn().mockResolvedValue([
        {
          job,
          jobId: "source-job-1",
          dispositionId: "source-job-1:4",
          attemptsMade: 3,
          maxAttempts: 4,
          failedReason: "[CHECKOUT_SURGE_RECOVERY_REQUIRED] database unavailable",
        },
        {
          job,
          jobId: "recovery-11111111-1111-4111-8111-111111111111-1",
          dispositionId: "recovery-11111111-1111-4111-8111-111111111111-1:1",
          attemptsMade: 1,
          maxAttempts: 1,
          failedReason: "[CHECKOUT_SURGE_RECOVERY_REQUIRED] recovery still unavailable",
        },
      ]),
    };
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      publisher,
      failedJobReader: reader,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      now: () => new Date("2026-06-22T00:00:10.000Z"),
    });

    await scanner.scanOnce();
    await scanner.scanOnce();

    expect(store.recordRecoverable).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceJobId: "source-job-1",
        sourceDisposition: "source-job-1:4",
      }),
    );
    expect(publisher.enqueue).toHaveBeenCalledOnce();
    expect(claimForPublication).toHaveBeenCalledTimes(2);
  });
});
