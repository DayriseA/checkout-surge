import {
  type DashboardProjection,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { describe, expect, it } from "vitest";
import type { BackendRead } from "../src/app/lib/api.js";
import type { RetainedTerminalRun } from "../src/app/lib/dashboard-projection-state.js";
import { deriveWatchComposition } from "../src/app/lib/presentation/watch-composition.js";

describe("watch composition", () => {
  it("selects saved cancellation before deriving stale same-run evidence, without cancelling another failure", () => {
    const failed = run("failed");
    const derive = (targetRunId: string) =>
      deriveWatchComposition({
        acceptedResult: {
          status: "available",
          runId: targetRunId,
          presetName: "Preview 1k",
          endedAt: "2026-07-30T12:00:04.000Z",
          cancellation: { automatic: true },
        },
        recovery: available(projection(failed)),
        retainedTerminalRun: null,
        latestCompletedRun: { status: "available", data: null },
        signalSamples: [],
        transportStatus: "connected",
        now: new Date("2026-07-30T12:00:04.000Z"),
      });
    const cancelled = derive(runId);
    expect(cancelled).toMatchObject({ phase: "cancelled", automatic: true });
    expect(cancelled).not.toHaveProperty("result");
    expect(derive("99999999-9999-4999-8999-999999999999").phase).toBe("failed");
  });

  it.each([
    ["starting", "starting"],
    ["active", "active"],
    ["draining", "draining"],
    ["completed", "completed"],
    ["failed", "failed"],
  ] as const)("maps authoritative %s lifecycle to the %s composition", (status, expected) => {
    expect(composition(available(projection(run(status)))).phase).toBe(expected);
  });

  it("uses the A04 starting presentation while active traffic is still preparing", () => {
    const currentRun = run("active");
    if (currentRun.status !== "active") throw new Error("Expected active run.");

    expect(
      composition(available(projection({ ...currentRun, trafficStatus: "starting" }))).phase,
    ).toBe("starting");
  });

  it.each([
    ["loading", { status: "loading" as const }, "checking"],
    ["unavailable", { status: "unavailable" as const, reason: "offline" }, "unavailable"],
    ["available idle", available(projection(null)), "idle"],
  ] as const)("maps a %s read without retained context", (_label, recovery, expected) => {
    expect(composition(recovery).phase).toBe(expected);
  });

  it("keeps completed and failed compositions after the active projection clears", () => {
    for (const status of ["completed", "failed"] as const) {
      const terminal = projection(run(status));
      const retained: RetainedTerminalRun = {
        runId,
        configSnapshot: terminal.currentRun?.configSnapshot ?? previewRunConfigSnapshotFixture(),
        terminalRecap: terminal,
      };

      const result = composition(available(projection(null)), retained);
      expect(result.phase).toBe(status);
      expect(result).toMatchObject({
        projection: terminal,
        run: { runId, presetName: "Preview 1k" },
      });
    }
  });

  it("uses fresh shared-runtime status with a retained terminal recap", () => {
    const terminal = projection(run("completed"));
    terminal.systemStatus = systemStatus(9, "2026-07-30T12:00:02.000Z");
    const retained: RetainedTerminalRun = {
      runId,
      configSnapshot: previewRunConfigSnapshotFixture(),
      terminalRecap: terminal,
    };
    const idle = projection(null);
    idle.systemStatus = systemStatus(1, "2026-07-30T12:00:04.000Z");

    const result = composition(available(idle), retained);

    expect(result.phase).toBe("completed");
    if (result.phase !== "completed") throw new Error("Expected completed composition.");
    expect(result.projection.systemStatus).toBe(idle.systemStatus);
    expect(result.projection.systemStatus).not.toBe(terminal.systemStatus);
    expect(result.projection.businessOutcome).toBe(terminal.businessOutcome);
  });

  it("prefers a newly-started run over retained terminal context", () => {
    const terminal = projection(run("completed"));
    const retained: RetainedTerminalRun = {
      runId,
      configSnapshot: previewRunConfigSnapshotFixture(),
      terminalRecap: terminal,
    };

    expect(composition(available(projection(run("starting"))), retained).phase).toBe("starting");
  });

  it("presents incomplete reset recovery and returns to idle after recovery completes", () => {
    const incomplete = projection(null);
    incomplete.resetRecovery = "incomplete";

    expect(composition(available(incomplete))).toMatchObject({
      phase: "reset-recovery",
      presentation: { state: "reset-recovery-incomplete", label: "recovery incomplete" },
    });
    expect(composition(available(projection(null)))).toMatchObject({
      phase: "idle",
      presentation: { state: "ready", label: "ready" },
    });
  });

  it("keeps a retained terminal recap after reset recovery returns ready", () => {
    const terminal = projection(run("completed"));
    terminal.resetRecovery = "incomplete";
    const retained: RetainedTerminalRun = {
      runId,
      configSnapshot: previewRunConfigSnapshotFixture(),
      terminalRecap: terminal,
    };

    expect(composition(available(projection(null)), retained).phase).toBe("completed");
    expect(composition(available(projection(null))).phase).toBe("idle");
  });
});

const runId = "11111111-1111-4111-8111-111111111111";
const saleOfferId = "33333333-3333-4333-8333-333333333333";
const startedAt = "2026-07-30T12:00:00.000Z";

function composition(
  recovery: BackendRead<DashboardProjection>,
  retainedTerminalRun: RetainedTerminalRun | null = null,
) {
  return deriveWatchComposition({
    recovery,
    retainedTerminalRun,
    latestCompletedRun: { status: "available", data: null },
    signalSamples: [],
    transportStatus: "connected",
    now: new Date("2026-07-30T12:00:04.000Z"),
  });
}

function run(status: DemoRunSnapshot["status"]): DemoRunSnapshot {
  const base = {
    runId,
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Preview 1k",
    operatorMode: "public" as const,
    saleOfferId,
    configSnapshot: previewRunConfigSnapshotFixture(),
    startedAt,
  };
  if (status === "starting") return { ...base, status, trafficStatus: "starting" };
  if (status === "active") {
    return { ...base, status, trafficStatus: "active", trafficStartedAt: startedAt };
  }
  if (status === "draining") {
    return {
      ...base,
      status,
      trafficStatus: "succeeded",
      trafficStartedAt: startedAt,
      trafficEndedAt: "2026-07-30T12:00:01.000Z",
    };
  }
  if (status === "completed") {
    return {
      ...base,
      status,
      trafficStatus: "succeeded",
      trafficStartedAt: startedAt,
      trafficEndedAt: "2026-07-30T12:00:01.000Z",
      finalizedAt: "2026-07-30T12:00:02.000Z",
    };
  }
  return {
    ...base,
    status,
    trafficStatus: "failed",
    trafficStartedAt: startedAt,
    trafficEndedAt: "2026-07-30T12:00:01.000Z",
    finalizedAt: "2026-07-30T12:00:02.000Z",
    failureCategory: "traffic",
  };
}

function projection(currentRun: DemoRunSnapshot | null): DashboardProjection {
  const scope = currentRun ? { runId: currentRun.runId, saleOfferId } : null;
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    correlationId: "corr-watch",
    scopeId: dashboardProjectionScopeId(scope),
    scope,
    revision: 1,
    recoveredAt: "2026-07-30T12:00:03.000Z",
    runtimeProgress: null,
    currentRun,
    inventory: null,
    recentMetrics: [],
    erp: null,
    systemStatus: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAttemptCounts: null,
    httpSummary: null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
  };
}

function available(data: DashboardProjection) {
  return { status: "available" as const, data, httpStatus: 200 };
}

function systemStatus(
  depth: number,
  observedAt: string,
): NonNullable<DashboardProjection["systemStatus"]> {
  return {
    queue: {
      name: "orders:process",
      connectivity: "reachable",
      depth,
      counts: { waiting: depth, prioritized: 0, paused: 0, delayed: 0, active: 0, failed: 0 },
      oldestWaitingAgeSeconds: null,
      retryPressure: {
        inspectedJobCount: 0,
        inspectionLimit: 100,
        retryingJobCount: 0,
        retryAttemptCount: 0,
        inspectionTruncated: false,
      },
      failedJobs: {
        totalCount: 0,
        recent: [],
        inspectionLimit: 20,
        inspectionTruncated: false,
      },
      observedAt,
    },
    erpProtection: {
      status: "healthy",
      reason: null,
      retryPressure: {
        retryingJobCount: 0,
        retryAttemptCount: 0,
        inspectedJobCount: 0,
        inspectionLimit: 100,
        inspectionTruncated: false,
      },
      observedAt,
    },
  };
}
