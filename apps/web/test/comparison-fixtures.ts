import {
  type ComparisonDetailResponse,
  type ComparisonStage,
  comparisonDetailResponseSchema,
  comparisonStageRoles,
  type DashboardProjection,
  dashboardProjectionSchemaName,
  dashboardProjectionScopeId,
  demoRunSnapshotSchema,
  deriveRunResult,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  emptyServerReservationTimingSummary,
  publicRunHistoryDetailResponseSchema,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";

export const comparisonId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const timestamp = "2026-10-11T20:00:00.000Z";
export function missingComparisonResponse() {
  return Response.json(
    {
      code: "resource_not_found",
      message: "Comparison was not found.",
      correlationId: "comparison-missing",
      timestamp,
    },
    { status: 404 },
  );
}
const autoResetAt = "2026-10-11T20:15:00.000Z";
const modes = ["demo", "without_redis", "demo", "without_order_queue"] as const;

export function comparisonFixture(
  state: ComparisonDetailResponse["state"] = "running",
  currentStage: 0 | 1 | 2 | 3 = 0,
  identity = comparisonId,
): ComparisonDetailResponse {
  const stages = comparisonStageRoles.map((role, index) => ({
    role,
    executionMode: modes[index],
    runId: `11111111-1111-4111-8111-11111111111${index}`,
    availability: "not_run",
  }));
  const detail = comparisonDetailResponseSchema.parse({
    comparisonId: identity,
    acceptedAt: timestamp,
    autoResetAt,
    state,
    currentStage,
    currentRunId: stages[currentStage]?.runId,
    stages,
    terminalReason: state === "failed" ? "child_failed" : null,
    currentFailureReason: state === "cleanup_pending" ? "cleanup_incomplete" : null,
    terminalAt: state === "completed" || state === "failed" ? timestamp : null,
    timestamp,
  });
  const stage = detail.stages[currentStage];
  detail.stages[currentStage] = {
    ...stage,
    availability: "pending",
    run: demoRunSnapshotSchema.parse({
      executionMode: stage.executionMode,
      comparisonId: identity,
      runId: stage.runId,
      presetId: "22222222-2222-4222-8222-222222222222",
      presetName: "Architecture comparison",
      operatorMode: "public",
      saleOfferId: "33333333-3333-4333-8333-333333333333",
      status: "active",
      trafficStatus: "active",
      startedAt: timestamp,
      trafficStartedAt: timestamp,
      autoResetAt,
      configSnapshot: previewRunConfigSnapshotFixture(),
    }),
  };
  return detail;
}

export function completedStage(stage: ComparisonStage, identity = comparisonId): ComparisonStage {
  const counts = {
    plannedRequests: 2000,
    startedRequests: 2000,
    completedRequests: 2000,
    unstartedRequests: 0,
    interruptedRequests: 0,
  };
  const http = {
    failedRequests: 0,
    acceptedResponses: 500,
    soldOutResponses: 1500,
    transportFailures: 0,
    unexpectedResponses: 0,
    failureRate: 0,
    buyerWallLatencySummary: {
      accepted: { sampleCount: 500, averageMs: 1200, p95Ms: 1800 },
      soldOut: { sampleCount: 1500, averageMs: 18, p95Ms: 28 },
    },
  };
  const result = deriveRunResult({
    runStatus: "completed",
    failureCategory: null,
    startingStock: 250,
    remainingStock: 0,
    durable: {
      reservedUnits: 250,
      uniqueReservations: 250,
      soldOutDecisions: 1500,
      confirmedOrders: 250,
      failedOrders: 0,
      queuedOrders: 0,
      processingOrders: 0,
      durablePendingPersistenceRecords: 0,
      notificationsRecorded: 250,
    },
    heldReservationsAwaitingPersistence: 0,
    replayPossible: true,
    generator: { transportAttemptCounts: counts, httpSummary: http },
  });
  const config = previewRunConfigSnapshotFixture();
  if (config.trafficConfig.mode !== "buyer-spike") throw new Error("Expected spike fixture");
  config.trafficConfig = { ...config.trafficConfig, duplicateEachBuyerAttempt: true };
  const detail = publicRunHistoryDetailResponseSchema.parse({
    run: {
      comparisonId: identity,
      executionMode: stage.executionMode,
      runId: stage.runId,
      presetName: "Architecture comparison",
      operatorMode: "public",
      status: "completed",
      trafficStatus: "succeeded",
      configSnapshot: config,
      startedAt: timestamp,
      trafficStartedAt: timestamp,
      trafficEndedAt: timestamp,
      finalizedAt: timestamp,
    },
    summary: {
      runId: stage.runId,
      presetName: "Architecture comparison",
      status: "completed",
      replayPossible: true,
      startedAt: timestamp,
      endedAt: timestamp,
      capturedAt: timestamp,
      transportAttemptCounts: counts,
      httpSummary: http,
      trafficDeliverySummary: {
        trafficMode: "buyer-spike",
        plannedBuyers: 1000,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        completedIterations: 1000,
        requestArrivalSummary: emptyRequestArrivalSummary,
        trafficDeliveryStatus: "complete",
      },
      serverReservationTimingSummary: emptyServerReservationTimingSummary,
      businessOutcomeSummary: {
        acceptedReservations: 250,
        reservedUnits: 250,
        soldOutRejections: 1500,
        queuedOrders: 0,
        processingOrders: 0,
        retryingOrders: 0,
        confirmedOrders: 250,
        failedOrders: 0,
        pendingPersistenceCount: 0,
        notificationsRecorded: 250,
      },
      runSignalTimelineSummary: null,
    },
    result,
    overallDurationMs: 10000,
    plannedAttempts: 2000,
    failureDiagnostic: null,
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    erpAttempts: {
      totalCount: 250,
      byStatus: { succeeded: 250, failed: 0, timedOut: 0 },
      averageLatencyMs: 20,
      p95LatencyMs: 20,
    },
    runSignalTimelineSummary: null,
    timestamp,
  });
  return {
    role: stage.role,
    runId: stage.runId,
    executionMode: stage.executionMode,
    availability: "available",
    detail,
  };
}

export function projectionFixture(
  detail: ComparisonDetailResponse,
  revision = 1,
): DashboardProjection {
  const stage = detail.stages[detail.currentStage as 0 | 1 | 2 | 3];
  if (stage.availability !== "pending" || !stage.run.saleOfferId)
    throw new Error("Expected pending fixture");
  const scope = { runId: stage.runId, saleOfferId: stage.run.saleOfferId };
  return {
    schema: dashboardProjectionSchemaName,
    scope,
    scopeId: dashboardProjectionScopeId(scope),
    revision,
    correlationId: "comparison-test",
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    currentRun: stage.run,
    inventory: null,
    recentMetrics: [],
    erp: null,
    systemStatus: null,
    businessOutcome: {
      acceptedReservations: 17,
      reservedUnits: 17,
      soldOutRejections: 4,
      queuedOrders: 10,
      processingOrders: 2,
      retryingOrders: 0,
      confirmedOrders: 5,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 5,
    },
    consistencyLag: null,
    transportAttemptCounts: null,
    httpSummary: null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
    recoveredAt: timestamp,
    runtimeProgress: null,
  };
}
