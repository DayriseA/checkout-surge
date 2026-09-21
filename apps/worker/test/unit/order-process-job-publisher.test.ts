import { orderProcessJobName } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  deadLetterFailureMarker,
  recoverableFailureMarker,
} from "../../src/queue/bullmq-order-process-consumer.js";
import {
  createOrderProcessJobPublisher,
  type WorkerOrderProcessJobPublisher,
} from "../../src/queue/bullmq-order-process-job-publisher.js";

const job = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-publisher-test",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
  processingGeneration: 0,
};

describe("worker order-processing job publisher", () => {
  it("uses the deterministic order ID as the BullMQ job ID", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const publisher: WorkerOrderProcessJobPublisher = createOrderProcessJobPublisher({
      rateLimit: async () => {},
      add,
      close,
    });

    await publisher.enqueue(job);
    await publisher.close();

    expect(add).toHaveBeenCalledWith(orderProcessJobName, job, {
      attempts: 1,
      jobId: job.orderId,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects invalid jobs before reaching the queue", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const publisher = createOrderProcessJobPublisher({
      rateLimit: async () => {},
      add,
      close: vi.fn(),
    });

    await expect(publisher.enqueue({ ...job, orderId: "invalid" })).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });

  it("discovers failed jobs from durable disposition metadata rather than human error text", async () => {
    const publisher = createOrderProcessJobPublisher({
      rateLimit: async () => {},
      add: vi.fn(),
      close: vi.fn(),
      getJobs: vi.fn().mockResolvedValue([
        {
          data: job,
          attemptsMade: 4,
          opts: { attempts: 4 },
          failedReason: "The ERP attempt result could not be persisted.",
          progress: {
            type: "recoverable_order_processing_failure",
            marker: recoverableFailureMarker,
            reason: "ErpAttemptPersistenceError",
          },
        },
        {
          data: job,
          attemptsMade: 4,
          opts: { attempts: 4 },
          failedReason: "order rejected",
          progress: 0,
        },
      ]),
    });

    await expect(publisher.findFailedOrderJobs(10)).resolves.toEqual([
      expect.objectContaining({ job, attemptsMade: 4, maxAttempts: 4 }),
    ]);
  });

  it("publishes recovery work with an explicit attempt-scoped ID and one delivery", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const publisher = createOrderProcessJobPublisher({
      rateLimit: async () => {},
      add,
      close: vi.fn(),
    });

    await publisher.enqueue(job, { jobId: "recovery-order-key-2", attempts: 1 });

    expect(add).toHaveBeenCalledWith(orderProcessJobName, job, {
      attempts: 1,
      jobId: "recovery-order-key-2",
    });
  });

  it("publishes generated-run jobs through the publication fence with one delivery", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const runJob = { ...job, runId: "55555555-5555-4555-8555-555555555555" };
    const publisher = createOrderProcessJobPublisher(
      { rateLimit: async () => {}, add, close: vi.fn() },
      {
        publish: vi.fn(async ({ operation }) => operation()),
      },
    );
    await publisher.enqueue(runJob);
    expect(add).toHaveBeenCalledWith(orderProcessJobName, runJob, {
      attempts: 1,
      jobId: job.orderId,
    });
  });

  it("refuses recovery publication after a generated run becomes terminal", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const runJob = { ...job, runId: "55555555-5555-4555-8555-555555555555" };
    const publish = vi.fn().mockRejectedValue(new Error("generated run is terminal"));
    const publisher = createOrderProcessJobPublisher(
      { rateLimit: async () => {}, add, close: vi.fn() },
      {
        publish,
      },
    );

    await expect(
      publisher.enqueue(runJob, { jobId: "recovery-terminal-run", attempts: 1 }),
    ).rejects.toThrow("generated run is terminal");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ runId: runJob.runId, saleOfferId: runJob.saleOfferId }),
    );
    expect(add).not.toHaveBeenCalled();
  });

  it("recovers from the stable failedReason marker when progress was not persisted", async () => {
    const publisher = createOrderProcessJobPublisher({
      rateLimit: async () => {},
      add: vi.fn(),
      close: vi.fn(),
      getJobs: vi.fn().mockResolvedValue([
        {
          id: "poison-source",
          name: "wrong-name",
          data: { invalid: true },
          attemptsMade: 4,
          opts: { attempts: 4 },
          failedReason: `${deadLetterFailureMarker} ${JSON.stringify({
            reason: "order_identity_mismatch",
            orderId: job.orderId,
            mismatchedFields: ["saleOfferId"],
            correlationId: job.correlationId,
            sourceError: "database unavailable",
          })}`,
        },
        {
          id: "source-job",
          data: job,
          attemptsMade: 4,
          opts: { attempts: 4 },
          failedReason: `${recoverableFailureMarker} Durable order recovery handoff failed.`,
        },
        {
          id: "human-text-job",
          data: job,
          attemptsMade: 4,
          opts: { attempts: 4 },
          failedReason: "database unavailable",
        },
        {
          id: "old-dead-letter-marker",
          data: job,
          attemptsMade: 4,
          opts: { attempts: 4 },
          failedReason: `${deadLetterFailureMarker} order_identity_mismatch`,
        },
      ]),
    });

    await expect(publisher.findFailedOrderJobs(10)).resolves.toEqual([
      expect.objectContaining({
        disposition: "dead_letter",
        jobId: "poison-source",
        reason: "order_identity_mismatch",
        orderId: job.orderId,
        mismatchedFields: ["saleOfferId"],
      }),
      expect.objectContaining({ jobId: "source-job", dispositionId: "source-job:5" }),
    ]);
  });

  it("returns raw poison jobs for DLQ reconciliation without parsing an order payload", async () => {
    const rawPayload = { orderId: "not-a-uuid", extra: "preserve" };
    const publisher = createOrderProcessJobPublisher({
      rateLimit: async () => {},
      add: vi.fn(),
      close: vi.fn(),
      getJobs: vi.fn().mockResolvedValue([
        {
          id: "poison-job",
          name: "wrong-name",
          data: rawPayload,
          attemptsMade: 4,
          opts: { attempts: 4 },
          failedReason: "database unavailable",
          progress: {
            type: "dead_letter_required",
            marker: deadLetterFailureMarker,
            reason: "order_identity_mismatch",
            orderId: "11111111-1111-4111-8111-111111111111",
            mismatchedFields: ["saleOfferId"],
            correlationId: "corr-poison",
          },
        },
      ]),
    });

    await expect(publisher.findFailedOrderJobs(10)).resolves.toEqual([
      expect.objectContaining({
        disposition: "dead_letter",
        jobId: "poison-job",
        jobName: "wrong-name",
        rawData: rawPayload,
        reason: "order_identity_mismatch",
        orderId: "11111111-1111-4111-8111-111111111111",
      }),
    ]);
  });
});
