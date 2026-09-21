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
        processingGeneration: 0,
        publicationOwner: null,
      },
    ]),
    readControlRecord: vi.fn().mockResolvedValue(null),
    markEscalated: vi.fn(),
    recordDeadLetter: vi.fn(),
    claimForPublication: vi.fn().mockResolvedValue(null),
    renewPublicationLease: vi.fn().mockResolvedValue(false),
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
      deliveryStateReader: { isDeliveryPending: async () => false },
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
      deliveryStateReader: { isDeliveryPending: async () => false },
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
      deliveryStateReader: { isDeliveryPending: async () => false },
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
          processingGeneration: 101,
          publicationOwner: null,
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
      deliveryStateReader: { isDeliveryPending: async () => false },
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ enqueued: 1 });
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
      deliveryStateReader: { isDeliveryPending: async () => false },
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

  it("renews the lease without re-claiming while the publication still waits in the queue", async () => {
    const owner = `recovery-${job.orderId}-1`;
    const store = persistence({
      findRecoverable: vi.fn().mockResolvedValue([
        {
          recoveryKey: `order:${job.orderId}`,
          job,
          reason: "accepted_result_incomplete",
          attempts: 1,
          createdAt: new Date("2026-06-21T00:00:00.000Z"),
          processingGeneration: 1,
          publicationOwner: owner,
        },
      ]),
      renewPublicationLease: vi.fn().mockResolvedValue(true),
    });
    const publisher = { enqueue: vi.fn() };
    const deliveryStateReader = { isDeliveryPending: vi.fn().mockResolvedValue(true) };
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      handler: { handle: vi.fn() },
      publisher,
      deliveryStateReader,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      now: () => new Date("2026-06-22T00:01:00.000Z"),
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({
      candidates: 1,
      enqueued: 0,
      failed: 0,
    });
    expect(deliveryStateReader.isDeliveryPending).toHaveBeenCalledWith(owner);
    expect(store.renewPublicationLease).toHaveBeenCalledWith({
      recoveryKey: `order:${job.orderId}`,
      processingGeneration: 1,
      publicationOwner: owner,
      now: new Date("2026-06-22T00:01:00.000Z"),
      leaseMs: 30_000,
    });
    expect(store.claimForPublication).not.toHaveBeenCalled();
    expect(publisher.enqueue).not.toHaveBeenCalled();
  });

  it("continues to renew the next candidate when a delivery state read fails", async () => {
    const secondJob = { ...job, orderId: "44444444-4444-4444-8444-444444444444" };
    const store = persistence({
      findRecoverable: vi.fn().mockResolvedValue(
        [job, secondJob].map((candidateJob) => ({
          recoveryKey: `order:${candidateJob.orderId}`,
          job: candidateJob,
          reason: "accepted_result_incomplete",
          attempts: 1,
          createdAt: new Date("2026-06-21T00:00:00.000Z"),
          processingGeneration: 1,
          publicationOwner: `recovery-${candidateJob.orderId}-1`,
        })),
      ),
      renewPublicationLease: vi.fn().mockResolvedValue(true),
    });
    const error = new Error("Redis unavailable");
    const deliveryStateReader = {
      isDeliveryPending: vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(true),
    };
    const publisher = { enqueue: vi.fn() };
    const logger = createSilentLogger("worker");
    const logError = vi.spyOn(logger, "error");
    const now = new Date("2026-06-22T00:01:00.000Z");
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      handler: { handle: vi.fn() },
      publisher,
      deliveryStateReader,
      logger,
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
      now: () => now,
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({
      candidates: 2,
      failed: 1,
      enqueued: 0,
    });
    expect(deliveryStateReader.isDeliveryPending).toHaveBeenNthCalledWith(
      1,
      `recovery-${job.orderId}-1`,
    );
    expect(deliveryStateReader.isDeliveryPending).toHaveBeenNthCalledWith(
      2,
      `recovery-${secondJob.orderId}-1`,
    );
    expect(store.claimForPublication).not.toHaveBeenCalled();
    expect(publisher.enqueue).not.toHaveBeenCalled();
    expect(store.markPublicationFailed).not.toHaveBeenCalled();
    expect(store.renewPublicationLease).toHaveBeenCalledExactlyOnceWith({
      recoveryKey: `order:${secondJob.orderId}`,
      processingGeneration: 1,
      publicationOwner: `recovery-${secondJob.orderId}-1`,
      now,
      leaseMs: 30_000,
    });
    expect(logError).toHaveBeenCalledExactlyOnceWith(
      { err: error, recoveryKey: `order:${job.orderId}`, orderId: job.orderId },
      "Order recovery delivery state could not be read.",
    );
  });

  it("re-claims and republishes once the queued delivery is no longer pending", async () => {
    const owner = `recovery-${job.orderId}-1`;
    const store = persistence({
      findRecoverable: vi.fn().mockResolvedValue([
        {
          recoveryKey: `order:${job.orderId}`,
          job,
          reason: "accepted_result_incomplete",
          attempts: 1,
          createdAt: new Date("2026-06-21T00:00:00.000Z"),
          processingGeneration: 1,
          publicationOwner: owner,
        },
      ]),
      claimForPublication: vi.fn().mockResolvedValue({
        attempt: 2,
        processingGeneration: 2,
        jobId: `recovery-${job.orderId}-2`,
      }),
    });
    const publisher = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const deliveryStateReader = { isDeliveryPending: vi.fn().mockResolvedValue(false) };
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      handler: { handle: vi.fn() },
      publisher,
      deliveryStateReader,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ candidates: 1, enqueued: 1 });
    expect(deliveryStateReader.isDeliveryPending).toHaveBeenCalledWith(owner);
    expect(store.renewPublicationLease).not.toHaveBeenCalled();
    expect(store.claimForPublication).toHaveBeenCalledOnce();
    expect(publisher.enqueue).toHaveBeenCalledWith(
      { ...job, processingGeneration: 2 },
      { jobId: `recovery-${job.orderId}-2`, attempts: 1 },
    );
  });

  it("re-claims an expired row without reading the queue state when no publication owner is set", async () => {
    const store = persistence({
      claimForPublication: vi.fn().mockResolvedValue({
        attempt: 1,
        processingGeneration: 1,
        jobId: `recovery-${job.orderId}-1`,
      }),
    });
    const publisher = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const deliveryStateReader = { isDeliveryPending: vi.fn() };
    const scanner = createOrderRecoveryScanner({
      persistence: store,
      handler: { handle: vi.fn() },
      publisher,
      deliveryStateReader,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 10,
      failedJobReader: { findFailedOrderJobs: async () => [] },
    });

    await expect(scanner.scanOnce()).resolves.toMatchObject({ candidates: 1, enqueued: 1 });
    expect(deliveryStateReader.isDeliveryPending).not.toHaveBeenCalled();
    expect(store.renewPublicationLease).not.toHaveBeenCalled();
    expect(store.claimForPublication).toHaveBeenCalledOnce();
    expect(publisher.enqueue).toHaveBeenCalledWith(
      { ...job, processingGeneration: 1 },
      { jobId: `recovery-${job.orderId}-1`, attempts: 1 },
    );
  });
});
