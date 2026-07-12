import type {
  ErpCircuitBreakerSnapshot,
  ErpResilienceStatus,
  QueueStatus,
} from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { ErpStatusService } from "../src/services/erp-status-service.js";
import { QueueStatusService } from "../src/services/queue-status-service.js";

const now = new Date("2026-06-22T00:00:10.000Z");

describe("ErpStatusService", () => {
  it("reports healthy ERP state when circuit, attempts, and retry pressure are clean", async () => {
    const service = buildService({
      circuit: circuitSnapshot({ state: "closed" }),
      queueStatus: queueStatusFixture(),
      readModel: erpReadModel(),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "healthy",
      reason: null,
      retryPressure: queueStatusFixture().retryPressure,
      updatedAt: now.toISOString(),
    });
  });

  it("reports unavailable ERP state while the circuit is open", async () => {
    const service = buildService({
      circuit: circuitSnapshot({
        state: "open",
        openedAt: "2026-06-22T00:00:00.000Z",
        nextAttemptAt: "2026-06-22T00:00:20.000Z",
      }),
      queueStatus: queueStatusFixture(),
      readModel: erpReadModel({ recentFailureCount: 5 }),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "unavailable",
      reason: "circuit_open",
    });
  });

  it("reports degraded ERP state when retries or recent failures are visible", async () => {
    const service = buildService({
      circuit: circuitSnapshot({ state: "closed" }),
      queueStatus: queueStatusFixture({
        retryPressure: {
          inspectedJobCount: 4,
          inspectionLimit: 100,
          retryingJobCount: 2,
          retryAttemptCount: 3,
          inspectionTruncated: false,
        },
      }),
      readModel: erpReadModel({ recentFailureCount: 1 }),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "degraded",
      reason: "erp_retries_pending",
      recentFailureCount: 1,
      retryPressure: { retryingJobCount: 2, retryAttemptCount: 3 },
    });
  });

  it("surfaces missing circuit state as degraded for operators", async () => {
    const service = buildService({
      circuit: null,
      queueStatus: queueStatusFixture(),
      readModel: erpReadModel(),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      status: "degraded",
      reason: "circuit_state_missing",
      circuit: null,
    });
  });

  it("reads the active run circuit and uses catalog scope when no run is active", async () => {
    const readSnapshot = vi.fn().mockResolvedValue(circuitSnapshot());
    const activeRunReader = {
      readActiveRunId: vi.fn().mockResolvedValue("55555555-5555-4555-8555-555555555555"),
    };
    const service = buildService({
      circuit: circuitSnapshot(),
      queueStatus: queueStatusFixture(),
      readModel: erpReadModel(),
      readSnapshot,
      activeRunReader,
    });
    await service.getStatus();
    expect(readSnapshot).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
    activeRunReader.readActiveRunId.mockResolvedValue(null);
    await service.getStatus();
    expect(readSnapshot).toHaveBeenLastCalledWith(null);
  });

  it("reports circuit scope lookup failure as unavailable without reading catalog state", async () => {
    const readSnapshot = vi.fn();
    const service = buildService({
      circuit: null,
      queueStatus: queueStatusFixture(),
      readModel: erpReadModel(),
      readSnapshot,
      activeRunReader: {
        readActiveRunId: vi.fn().mockRejectedValue(new Error("database unavailable")),
      },
    });
    await expect(service.getStatus()).resolves.toMatchObject({
      status: "unavailable",
      reason: "circuit_state_unavailable",
      circuit: null,
    });
    expect(readSnapshot).not.toHaveBeenCalled();
  });
});

function buildService(options: {
  circuit: ErpCircuitBreakerSnapshot | null;
  queueStatus: QueueStatus;
  readModel: Awaited<ReturnType<typeof erpReadModel>>;
  readSnapshot?: (runId: string | null) => Promise<ErpCircuitBreakerSnapshot | null>;
  activeRunReader?: { readActiveRunId(): Promise<string | null> };
}): ErpStatusService {
  const queueStatusService = new QueueStatusService(
    { inspect: async () => options.queueStatus },
    createSilentLogger("api"),
  );

  return new ErpStatusService({
    circuitBreakerStateReader: {
      readSnapshot: options.readSnapshot ?? (async () => options.circuit),
    },
    attemptStatusReader: { readStatus: async () => options.readModel },
    queueStatusService,
    logger: createSilentLogger("api"),
    now: () => now,
    ...(options.activeRunReader ? { activeRunReader: options.activeRunReader } : {}),
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
    updatedAt: "2026-06-22T00:00:00.000Z",
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
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function erpReadModel(overrides: Partial<ErpResilienceStatus> = {}) {
  return {
    latestAttempt: null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount: 0,
    recentFailureCount: 0,
    recentTimeoutCount: 0,
    confirmationDelay: {
      processingOrderCount: 0,
      oldestProcessingAgeSeconds: null,
      recentConfirmedCount: 0,
      averageConfirmationDelayMs: null,
    },
    ...overrides,
  };
}
