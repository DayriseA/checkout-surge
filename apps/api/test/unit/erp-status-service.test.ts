import type { QueueStatus, RunErpOutcomeSummary } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  RunErpOutcomeService,
  SharedErpProtectionService,
} from "../../src/services/erp-status-service.js";
import { QueueStatusService } from "../../src/services/queue-status-service.js";

const now = new Date("2026-06-22T00:00:10.000Z");
const runId = "55555555-5555-4555-8555-555555555555";

describe("SharedErpProtectionService", () => {
  it("reports healthy shared state without retry pressure", async () => {
    const service = buildSharedService();

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "healthy",
      reason: null,
      observedAt: now.toISOString(),
    });
  });

  it("derives shared degradation from global retry pressure", async () => {
    const service = buildSharedService({
      queueStatus: queueStatusFixture({
        retryPressure: {
          inspectedJobCount: 4,
          inspectionLimit: 100,
          retryingJobCount: 2,
          retryAttemptCount: 3,
          inspectionTruncated: false,
        },
      }),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "degraded",
      reason: "erp_retries_pending",
      retryPressure: { retryingJobCount: 2, retryAttemptCount: 3 },
    });
  });

  it("reports a failed queue read as degraded with empty retry pressure", async () => {
    const service = buildSharedService({
      inspect: async () => {
        throw new Error("queue unavailable");
      },
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "degraded",
      reason: "retry_pressure_unavailable",
      retryPressure: { retryingJobCount: 0, retryAttemptCount: 0 },
    });
  });
});

describe("RunErpOutcomeService", () => {
  it("reads attempts at the supplied run scope", async () => {
    const readStatus = vi.fn().mockResolvedValue(erpReadModel());
    const service = new RunErpOutcomeService({
      attemptStatusReader: { readStatus },
      logger: createSilentLogger("api"),
      now: () => now,
    });

    const outcome = await service.getOutcomes({ runId });
    expect(outcome).toEqual({ runId, ...erpReadModel(), observedAt: now.toISOString() });
    expect(outcome).not.toHaveProperty("status");
    expect(outcome).not.toHaveProperty("reason");
    expect(readStatus).toHaveBeenCalledWith({ runId }, now, 60);
  });
});

function buildSharedService(
  options: { queueStatus?: QueueStatus; inspect?: () => Promise<QueueStatus> } = {},
): SharedErpProtectionService {
  const queueStatusService = new QueueStatusService(
    { inspect: options.inspect ?? (async () => options.queueStatus ?? queueStatusFixture()) },
    createSilentLogger("api"),
  );
  return new SharedErpProtectionService({
    queueStatusService,
    logger: createSilentLogger("api"),
    now: () => now,
  });
}

function queueStatusFixture(overrides: Partial<QueueStatus> = {}): QueueStatus {
  return {
    name: "orders:process",
    connectivity: "reachable",
    depth: 0,
    counts: { waiting: 0, prioritized: 0, paused: 0, delayed: 0, active: 0, failed: 0 },
    oldestWaitingAgeSeconds: null,
    retryPressure: {
      inspectedJobCount: 0,
      inspectionLimit: 100,
      retryingJobCount: 0,
      retryAttemptCount: 0,
      inspectionTruncated: false,
    },
    failedJobs: { totalCount: 0, recent: [], inspectionLimit: 20, inspectionTruncated: false },
    observedAt: now.toISOString(),
    ...overrides,
  };
}

function erpReadModel(): Omit<RunErpOutcomeSummary, "runId" | "observedAt"> {
  return {
    latestAttempt: null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount: 0,
    recentFailureCount: 0,
    recentTimeoutCount: 0,
    recentAttemptCoverage: "retained_history",
    attemptRetentionLimitPerOrder: 32,
    cumulativeOutcomeCounts: {
      capacityRejected: 0,
      temporarilyUnavailable: 0,
      uncertainResult: 0,
      permanentRejected: 0,
    },
  };
}
