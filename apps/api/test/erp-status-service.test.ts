import type {
  ErpCircuitBreakerSnapshot,
  QueueStatus,
  RunErpOutcomeSummary,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  RunErpOutcomeService,
  SharedErpProtectionService,
} from "../src/services/erp-status-service.js";
import { QueueStatusService } from "../src/services/queue-status-service.js";

const now = new Date("2026-06-22T00:00:10.000Z");
const runId = "55555555-5555-4555-8555-555555555555";

describe("SharedErpProtectionService", () => {
  it("reads catalog protection and reports healthy shared state", async () => {
    const readSnapshot = vi.fn().mockResolvedValue(circuitSnapshot());
    const service = buildSharedService({ readSnapshot });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "healthy",
      reason: null,
      observedAt: now.toISOString(),
    });
    expect(readSnapshot).toHaveBeenCalledWith({ type: "catalog" });
  });

  it("derives shared degradation from global retry pressure only", async () => {
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

  it("reports unavailable shared protection while the catalog circuit is open", async () => {
    const service = buildSharedService({
      circuit: circuitSnapshot({
        state: "open",
        openedAt: "2026-06-22T00:00:00.000Z",
        nextAttemptAt: "2026-06-22T00:00:20.000Z",
      }),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "unavailable",
      reason: "circuit_open",
    });
  });

  it("reports missing catalog protection as degraded", async () => {
    const service = buildSharedService({ circuit: null });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "degraded",
      reason: "circuit_state_missing",
      circuit: null,
    });
  });

  it("reports a failed catalog circuit read as unavailable", async () => {
    const service = buildSharedService({
      readSnapshot: async () => {
        throw new Error("Redis unavailable");
      },
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "unavailable",
      reason: "circuit_state_unavailable",
      circuit: null,
    });
  });
});

describe("RunErpOutcomeService", () => {
  it("reads the circuit and attempts at the supplied run scope", async () => {
    const readSnapshot = vi.fn().mockResolvedValue(circuitSnapshot());
    const readStatus = vi.fn().mockResolvedValue(erpReadModel());
    const service = new RunErpOutcomeService({
      circuitBreakerStateReader: { readSnapshot },
      attemptStatusReader: { readStatus },
      logger: createSilentLogger("api"),
      now: () => now,
    });

    await expect(service.getOutcomes({ runId })).resolves.toMatchObject({
      runId,
      circuitReadStatus: "available",
      recentAttemptCount: 0,
      observedAt: now.toISOString(),
    });
    expect(readSnapshot).toHaveBeenCalledWith({ type: "run", runId });
    expect(readStatus).toHaveBeenCalledWith({ runId }, now, 60);
  });

  it("treats an absent run circuit as neutral outcome data, not degradation", async () => {
    const service = new RunErpOutcomeService({
      circuitBreakerStateReader: { readSnapshot: async () => null },
      attemptStatusReader: { readStatus: async () => erpReadModel() },
      logger: createSilentLogger("api"),
      now: () => now,
    });

    const outcome = await service.getOutcomes({ runId });
    expect(outcome).toEqual({
      runId,
      circuit: null,
      circuitReadStatus: "available",
      ...erpReadModel(),
      observedAt: now.toISOString(),
    });
    expect(outcome).not.toHaveProperty("status");
    expect(outcome).not.toHaveProperty("reason");
  });

  it("preserves attempt evidence when the run circuit read fails", async () => {
    const error = new Error("Redis unavailable");
    const logger = createSilentLogger("api");
    const logError = vi.spyOn(logger, "error");
    const service = new RunErpOutcomeService({
      circuitBreakerStateReader: {
        readSnapshot: async () => {
          throw error;
        },
      },
      attemptStatusReader: {
        readStatus: async () => ({
          ...erpReadModel(),
          recentAttemptCount: 3,
          recentFailureCount: 1,
        }),
      },
      logger,
      now: () => now,
    });

    await expect(service.getOutcomes({ runId })).resolves.toMatchObject({
      runId,
      circuit: null,
      circuitReadStatus: "unavailable",
      recentAttemptCount: 3,
      recentFailureCount: 1,
      observedAt: now.toISOString(),
    });
    expect(logError).toHaveBeenCalledWith(
      { err: error, runId },
      "Run ERP circuit breaker state read failed.",
    );
  });
});

function buildSharedService(
  options: {
    circuit?: ErpCircuitBreakerSnapshot | null;
    queueStatus?: QueueStatus;
    readSnapshot?: (
      scope: { type: "catalog" } | { type: "run"; runId: string },
    ) => Promise<ErpCircuitBreakerSnapshot | null>;
  } = {},
): SharedErpProtectionService {
  const queueStatusService = new QueueStatusService(
    { inspect: async () => options.queueStatus ?? queueStatusFixture() },
    createSilentLogger("api"),
  );
  return new SharedErpProtectionService({
    circuitBreakerStateReader: {
      readSnapshot:
        options.readSnapshot ??
        (async () => (options.circuit === undefined ? circuitSnapshot() : options.circuit)),
    },
    queueStatusService,
    logger: createSilentLogger("api"),
    now: () => now,
  });
}

function circuitSnapshot(
  overrides: Partial<ErpCircuitBreakerSnapshot> = {},
): ErpCircuitBreakerSnapshot {
  return {
    state: "closed",
    consecutiveFailureCount: 0,
    failureThreshold: 5,
    resetTimeoutMs: 10_000,
    openedAt: null,
    nextAttemptAt: null,
    halfOpenProbeInFlight: false,
    lastChangedAt: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
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

function erpReadModel(): Omit<
  RunErpOutcomeSummary,
  "runId" | "circuit" | "circuitReadStatus" | "observedAt"
> {
  return {
    latestAttempt: null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount: 0,
    recentFailureCount: 0,
    recentTimeoutCount: 0,
  };
}
