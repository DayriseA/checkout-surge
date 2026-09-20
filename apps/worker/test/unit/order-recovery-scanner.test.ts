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
  processingGeneration: 0,
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
    readControlRecord: vi.fn().mockResolvedValue(null),
    markEscalated: vi.fn(),
    recordDeadLetter: vi.fn(),
    claimForPublication: vi.fn().mockResolvedValue(null),
    markPublicationFailed: vi.fn(),
    markResolved: vi.fn(),
    reconcileTerminal: vi.fn().mockResolvedValue(0),
    defer: vi.fn().mockResolvedValue(true),
    resolveDispatchedCall: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("order recovery scanner", () => {
  it("publishes attempt-scoped deterministic IDs and claims durable attempts", async () => {
    const store = persistence({
      claimForPublication: vi.fn().mockResolvedValue({
        attempt: 2,
        processingGeneration: 7,
        jobId: `recovery-${job.orderId}-2`,
      }),
      markPublicationFailed: vi.fn(),
    });
    const publisher = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      handler: { handle: vi.fn() },
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      now: () => new Date("2026-06-22T00:00:10.000Z"),
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ candidates: 1, enqueued: 1 });
    expect(publisher.enqueue).toHaveBeenCalledWith(
      { ...job, processingGeneration: 7 },
      {
        jobId: "recovery-11111111-1111-4111-8111-111111111111-2",
        attempts: 1,
      },
    );
    expect(store.claimForPublication).toHaveBeenCalledOnce();
    expect(store.claimForPublication).toHaveBeenCalledWith({
      recoveryKey: "order:11111111-1111-4111-8111-111111111111",
      now: new Date("2026-06-22T00:00:10.000Z"),
      leaseMs: 30_000,
    });
  });

  it("fences publication failure with the claimed processing generation", async () => {
    const store = persistence({
      claimForPublication: vi.fn().mockResolvedValue({
        attempt: 2,
        processingGeneration: 7,
        jobId: `recovery-${job.orderId}-2`,
      }),
      markPublicationFailed: vi.fn(),
    });
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      handler: { handle: vi.fn() },
      publisher: { enqueue: vi.fn().mockRejectedValue(new Error("queue unavailable")) },
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      now: () => new Date("2026-06-22T00:00:10.000Z"),
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ candidates: 1, failed: 1 });
    expect(store.markPublicationFailed).toHaveBeenCalledWith({
      recoveryKey: "order:11111111-1111-4111-8111-111111111111",
      error: "queue unavailable",
      nextAttemptAt: new Date("2026-06-22T00:00:11.000Z"),
      processingGeneration: 7,
    });
  });

  it("hands snapshot publication failures to the order handler under the claimed generation", async () => {
    const corruption = new Error("invalid snapshot");
    corruption.name = "PersistedRunConfigCorruptionError";
    const store = persistence({
      claimForPublication: vi.fn().mockResolvedValue({
        attempt: 2,
        processingGeneration: 7,
        jobId: `recovery-${job.orderId}-2`,
      }),
    });
    const handle = vi.fn();
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      handler: { handle },
      publisher: { enqueue: vi.fn().mockRejectedValue(corruption) },
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ candidates: 1, failed: 0 });
    expect(handle).toHaveBeenCalledWith(
      { ...job, processingGeneration: 7 },
      expect.objectContaining({ processingGeneration: 7 }),
    );
    expect(store.markPublicationFailed).not.toHaveBeenCalled();
  });

  it("does not abandon work after the former recovery budget", async () => {
    const store = persistence({
      findRecoverable: vi.fn().mockResolvedValue([
        {
          recoveryKey: "order:key",
          job,
          reason: "persist",
          attempts: 101,
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
        },
      ]),
      claimForPublication: vi.fn().mockResolvedValue({
        attempt: 102,
        processingGeneration: 102,
        jobId: `recovery-${job.orderId}-102`,
      }),
    });
    const publisher = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      handler: { handle: vi.fn() },
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      maxRecoveryAttempts: 3,
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ escalated: 0, enqueued: 1 });
    expect(store.markEscalated).not.toHaveBeenCalled();
    expect(store.claimForPublication).toHaveBeenCalledOnce();
    expect(publisher.enqueue).toHaveBeenCalledWith(
      { ...job, processingGeneration: 102 },
      { jobId: `recovery-${job.orderId}-102`, attempts: 1 },
    );
  });

  it("ingests one failed BullMQ disposition without resetting an active claim on rescans", async () => {
    const claimForPublication = vi
      .fn()
      .mockResolvedValueOnce({
        attempt: 1,
        processingGeneration: 1,
        jobId: `recovery-${job.orderId}-1`,
      })
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
      handler: { handle: vi.fn() },
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
