import type { OrderProcessJob } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type BullMqQueueInspectionClient,
  createOrderProcessQueueInspector,
} from "../../src/queue/bullmq-order-process-queue-inspector.js";

const measuredAt = new Date("2026-06-22T12:00:20.000Z");

describe("order-processing queue inspection", () => {
  it("derives exact state counts and bounded wait and failure visibility", async () => {
    const queue = fakeQueue({
      counts: { waiting: 5, prioritized: 2, paused: 4, delayed: 3, active: 1, failed: 4 },
      oldestWaitingJobs: [
        job({ id: "waiting", timestamp: measuredAt.getTime() - 12_000 }),
        job({ id: "paused", timestamp: measuredAt.getTime() - 15_000 }),
      ],
      failedJobs: [
        job({
          id: "failed-newest",
          attemptsMade: 3,
          failedReason: "ERP unavailable",
          finishedOn: measuredAt.getTime() - 1_000,
        }),
        job({
          id: "failed-older",
          attemptsMade: 1,
          failedReason: "Timed out",
          finishedOn: measuredAt.getTime() - 2_000,
        }),
      ],
    });
    const inspector = createOrderProcessQueueInspector(queue, {
      now: () => measuredAt,
      failedJobInspectionLimit: 2,
    });

    await expect(inspector.inspect()).resolves.toMatchObject({
      name: "orders:process",
      connectivity: "reachable",
      depth: 14,
      counts: { waiting: 5, prioritized: 2, paused: 4, delayed: 3, active: 1, failed: 4 },
      oldestWaitingAgeSeconds: 15,
      failedJobs: {
        totalCount: 4,
        inspectionLimit: 2,
        inspectionTruncated: true,
        recent: [
          expect.objectContaining({ jobId: "failed-newest", failedReason: "ERP unavailable" }),
          expect.objectContaining({ jobId: "failed-older", failedReason: "Timed out" }),
        ],
      },
      observedAt: measuredAt.toISOString(),
    });
    expect(queue.getJobs).toHaveBeenCalledWith(["waiting", "prioritized", "paused"], 0, 0, true);
    expect(queue.getJobs).toHaveBeenCalledTimes(2);
  });

  it("skips jobs removed between BullMQ state and job reads", async () => {
    const queue = fakeQueue({
      counts: { waiting: 2, failed: 2 },
      oldestWaitingJobs: [undefined, job({ timestamp: measuredAt.getTime() - 7_000 })],
      failedJobs: [undefined, job({ id: "surviving-failure", failedReason: "ERP unavailable" })],
    });

    await expect(
      createOrderProcessQueueInspector(queue, { now: () => measuredAt }).inspect(),
    ).resolves.toMatchObject({
      depth: 2,
      counts: { waiting: 2, failed: 2 },
      oldestWaitingAgeSeconds: 7,
      failedJobs: {
        totalCount: 2,
        recent: [expect.objectContaining({ jobId: "surviving-failure" })],
        inspectionTruncated: true,
      },
    });
  });

  it("uses one lightweight count command for connectivity", async () => {
    const queue = fakeQueue({});
    const inspector = createOrderProcessQueueInspector(queue);

    await inspector.checkConnectivity();

    expect(queue.getJobCounts).toHaveBeenCalledWith("waiting");
  });
});

function fakeQueue(options: {
  counts?: Record<string, number>;
  oldestWaitingJobs?: (ReturnType<typeof job> | undefined)[];
  failedJobs?: (ReturnType<typeof job> | undefined)[];
}): BullMqQueueInspectionClient {
  return {
    getJobCounts: vi.fn().mockResolvedValue(options.counts ?? {}),
    getJobs: vi.fn(async (types: string[]) => {
      if (types.length === 1 && types[0] === "failed") {
        return options.failedJobs ?? [];
      }
      if (types.length === 3) {
        return options.oldestWaitingJobs ?? [];
      }
      return [];
    }),
    close: vi.fn().mockResolvedValue(undefined),
  } as BullMqQueueInspectionClient;
}

function job(
  overrides: Partial<{
    id: string;
    timestamp: number;
    attemptsMade: number;
    failedReason: string;
    finishedOn: number;
  }> = {},
) {
  return {
    id: overrides.id ?? "job-id",
    name: "order.process",
    data: {} as OrderProcessJob,
    timestamp: overrides.timestamp ?? measuredAt.getTime(),
    attemptsMade: overrides.attemptsMade ?? 0,
    failedReason: overrides.failedReason,
    finishedOn: overrides.finishedOn,
  } as never;
}
