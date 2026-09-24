import {
  type DashboardProjection,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionScopeId,
  deriveRunResult,
  type RunResultEvidence,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { describe, expect, it } from "vitest";
import {
  deriveInventoryOutcomeState,
  deriveLagPresentationState,
  deriveOutcomePresentationState,
  deriveRunErpOutcomeState,
  deriveRunPresentationState,
  deriveTerminalSummaryPresentation,
} from "../src/app/lib/presentation/run-presentation-state.js";

describe("run presentation state", () => {
  it.each([
    [{ status: "loading" as const }, "checking availability"],
    [{ status: "available" as const, data: projection(null), httpStatus: 200 }, "ready"],
    [
      { status: "available" as const, data: projection(run("starting")), httpStatus: 200 },
      "starting",
    ],
    [
      { status: "available" as const, data: projection(run("active")), httpStatus: 200 },
      "accepting checkout attempts",
    ],
    [
      { status: "available" as const, data: projection(run("draining")), httpStatus: 200 },
      "processing unique reservations",
    ],
    [{ status: "available" as const, data: projection(run("failed")), httpStatus: 200 }, "failed"],
  ])("maps authoritative lifecycle to %s", (read, expected) => {
    expect(deriveRunPresentationState(read).label).toBe(expected);
  });

  it("presents incomplete reset recovery until the idle projection is repaired", () => {
    const incomplete = projection(null);
    incomplete.resetRecovery = "incomplete";

    expect(deriveRunPresentationState(available(incomplete))).toMatchObject({
      state: "reset-recovery-incomplete",
      label: "recovery incomplete",
      tone: "warning",
    });
    expect(deriveRunPresentationState(available(projection(null)))).toMatchObject({
      state: "ready",
      label: "ready",
    });
  });

  it("prefers a current run over stale incomplete-reset metadata", () => {
    const data = projection(run("active"));
    data.resetRecovery = "incomplete";

    expect(deriveRunPresentationState(available(data)).state).toBe("accepting-checkout-attempts");
  });

  it.each([
    {
      name: "completed success",
      status: "completed" as const,
      acceptedReservations: 10,
      allocatedStock: 10,
      confirmedOrders: 10,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      expected: "completed successfully",
    },
    {
      name: "order failures",
      status: "completed" as const,
      acceptedReservations: 10,
      allocatedStock: 10,
      confirmedOrders: 9,
      failedOrders: 1,
      pendingPersistenceCount: 0,
      expected: "completed with order failures",
    },
    {
      name: "unsettled orders",
      status: "completed" as const,
      acceptedReservations: 10,
      allocatedStock: 10,
      confirmedOrders: 9,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      expected: "completed with unsettled orders",
    },
    {
      name: "oversell before failures and unsettled orders",
      status: "completed" as const,
      acceptedReservations: 11,
      allocatedStock: 10,
      confirmedOrders: 8,
      failedOrders: 1,
      pendingPersistenceCount: 1,
      expected: "completed with oversell",
    },
    {
      name: "failed before every completed outcome",
      status: "failed" as const,
      acceptedReservations: 11,
      allocatedStock: 10,
      confirmedOrders: 8,
      failedOrders: 1,
      pendingPersistenceCount: 1,
      expected: "failed",
    },
  ])("derives $name at the projection seam", (example) => {
    const data = projection(run(example.status));
    data.inventory = inventory(example.allocatedStock);
    data.businessOutcome = {
      acceptedReservations: example.acceptedReservations,
      reservedUnits: example.acceptedReservations,
      soldOutRejections: 0,
      queuedOrders: Math.max(
        0,
        example.acceptedReservations - example.confirmedOrders - example.failedOrders,
      ),
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: example.confirmedOrders,
      failedOrders: example.failedOrders,
      pendingPersistenceCount: example.pendingPersistenceCount,
      notificationsRecorded: 0,
    };

    expect(deriveRunPresentationState({ status: "available", data, httpStatus: 200 }).label).toBe(
      example.expected,
    );
  });

  it.each([
    { failedOrders: 0, queuedOrders: 0, expected: ["completed successfully", "ok"] },
    {
      failedOrders: 1,
      queuedOrders: 0,
      expected: ["completed with order failures", "warning"],
    },
    {
      failedOrders: 0,
      queuedOrders: 1,
      expected: ["completed with unsettled orders", "warning"],
    },
  ])("derives $expected.0 from durable terminal evidence", (example) => {
    const presentation = deriveTerminalSummaryPresentation(
      deriveRunResult(
        resultEvidence({
          confirmedOrders: 10 - example.failedOrders - example.queuedOrders,
          failedOrders: example.failedOrders,
          queuedOrders: example.queuedOrders,
        }),
      ),
    );
    expect([presentation.label, presentation.tone]).toEqual(example.expected);
  });

  it("presents broken completed evidence as contradictory and dangerous", () => {
    const data = projection(run("completed"));
    data.inventory = inventory(10);
    data.businessOutcome = {
      ...businessOutcome(10),
      reservedUnits: 9,
    };

    expect(
      deriveRunPresentationState({ status: "available", data, httpStatus: 200 }),
    ).toMatchObject({
      label: "contradictory outcome evidence",
      tone: "danger",
    });
  });

  it("keeps a valid terminal outcome successful when reconciliation has a warning", () => {
    const result = deriveRunResult(resultEvidence({ durablePendingPersistenceRecords: 1 }));

    expect(result.maximumClassification).toBe("warning");
    expect(deriveTerminalSummaryPresentation(result)).toMatchObject({
      label: "completed successfully",
      tone: "ok",
    });
  });

  it("treats exact sellout with zero oversell as success", () => {
    const presentation = deriveInventoryOutcomeState(inventory(10), null, 10);

    expect([presentation.label, presentation.tone]).toEqual(["exact sellout", "ok"]);
  });

  it("keeps active depleted inventory draining until durable reservation evidence exists", () => {
    expect(deriveInventoryOutcomeState(inventory(10), run("active"), null)).toMatchObject({
      state: "inventory-draining",
      label: "inventory draining",
      tone: "progress",
    });
  });

  it("uses inventory-specific copy when completed reservation evidence is unavailable", () => {
    expect(deriveInventoryOutcomeState(inventory(10), run("completed"), null)).toMatchObject({
      state: "inventory-reservation-evidence-unavailable",
      label: "reservation evidence unavailable",
      description: "Durable reservation evidence was unavailable for this run.",
      tone: "idle",
    });
  });

  it.each([
    "completed",
    "failed",
  ] as const)("uses final absence semantics across missing %s run evidence", (status) => {
    const terminalRun = run(status);
    const read = {
      status: "available" as const,
      data: projection(terminalRun),
      httpStatus: 200,
    };
    const runState = deriveRunPresentationState(read);

    expect(runState).toMatchObject({
      state: status === "completed" ? "terminal-outcome-unavailable" : "failed",
      label: status === "completed" ? "outcome unavailable" : "failed",
    });
    expect(deriveInventoryOutcomeState(null, terminalRun)).toMatchObject({
      state: "inventory-evidence-unavailable",
      label: "inventory evidence unavailable",
    });
    expect(deriveLagPresentationState(null, null, terminalRun)).toMatchObject({
      state: "lag-evidence-unavailable",
      label: "confirmation evidence unavailable",
    });
    expect(deriveOutcomePresentationState(null, terminalRun, runState)).toMatchObject({
      state: "outcome-evidence-unavailable",
      label: "checkout evidence unavailable",
    });
    expect(deriveRunErpOutcomeState(null, terminalRun)).toMatchObject({
      state: "run-erp-evidence-unavailable",
      label: "ERP evidence unavailable",
    });
  });

  it("does not claim that no ERP call was recorded when the latest attempt is outside the recent window", () => {
    const erp = {
      runId,
      latestAttempt: { runId, status: "failed" as const, finishedAt: "2026-07-30T12:00:01.000Z" },
      recentAttemptWindowSeconds: 60,
      recentAttemptCount: 0,
      recentFailureCount: 0,
      recentTimeoutCount: 0,
      observedAt: "2026-07-30T12:02:00.000Z",
    };

    expect(deriveRunErpOutcomeState(erp, run("draining"))).toMatchObject({
      state: "run-erp-failures-observed",
    });
    expect(
      deriveRunErpOutcomeState({ ...erp, latestAttempt: null }, run("draining")),
    ).toMatchObject({ state: "run-erp-no-calls-yet", label: "no ERP calls yet" });
  });
});

const runId = "11111111-1111-4111-8111-111111111111";
const saleOfferId = "33333333-3333-4333-8333-333333333333";
const startedAt = "2026-07-30T12:00:00.000Z";

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
  const scope = currentRun ? { runId, saleOfferId } : null;
  return {
    schema: dashboardProjectionSchemaName,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    correlationId: "corr-presentation",
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

function inventory(allocatedStock: number): NonNullable<DashboardProjection["inventory"]> {
  return {
    saleOfferId,
    allocatedStock,
    remainingStock: 0,
    reservedStock: allocatedStock,
    pendingPersistenceCount: 0,
    expiredReservationCount: 0,
    oldestPendingPersistenceAgeSeconds: 0,
    reservationThroughput: {
      windowSeconds: 60,
      successfulReservationCount: allocatedStock,
      peakRatePerSecond: allocatedStock,
      peakWindowSeconds: 1,
      unit: "reservations_per_second",
      measuredAt: "2026-07-30T12:00:00.000Z",
    },
    soldOutPressure: { rejectionCount: 4, latestObservedAt: "2026-07-30T12:00:00.000Z" },
    observedAt: "2026-07-30T12:00:01.000Z",
    lastUpdatedAt: "2026-07-30T12:00:00.000Z",
  };
}

function resultEvidence(
  durableOverrides: Partial<NonNullable<RunResultEvidence["durable"]>> = {},
): RunResultEvidence {
  return {
    runStatus: "completed",
    failureCategory: null,
    startingStock: 10,
    remainingStock: 0,
    durable: {
      reservedUnits: 10,
      uniqueReservations: 10,
      soldOutDecisions: 0,
      confirmedOrders: 10,
      failedOrders: 0,
      queuedOrders: 0,
      processingOrders: 0,
      durablePendingPersistenceRecords: 0,
      notificationsRecorded: 10,
      ...durableOverrides,
    },
    heldReservationsAwaitingPersistence: 0,
    replayPossible: false,
    generator: null,
  };
}

function businessOutcome(acceptedReservations: number) {
  return {
    acceptedReservations,
    reservedUnits: acceptedReservations,
    soldOutRejections: 0,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: acceptedReservations,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: acceptedReservations,
  };
}
