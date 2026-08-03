import {
  type DashboardProjection,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
} from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CompletionOutcomesPanel,
  ConsistencyLagPanel,
  InventoryDrainPanel,
  RecoveryStatusPanel,
  RequestSurgePanel,
  RunErpOutcomesPanel,
  RunOutcomesPanel,
  SystemStatusPanel,
} from "../src/app/components/dashboard-panels.js";
import type { Freshness } from "../src/app/lib/presentation/freshness.js";
import {
  deriveInventoryOutcomeState,
  deriveLagPresentationState,
  deriveOutcomePresentationState,
  deriveRunErpOutcomeState,
  deriveRunPresentationState,
  deriveSharedErpProtectionState,
  deriveSharedRuntimeState,
  type PresentationState,
} from "../src/app/lib/presentation/run-presentation-state.js";

describe("Phase 6 projection dashboard", () => {
  it("renders neutral initial hydration without recovery controls", () => {
    const recovery = { status: "loading" as const };
    const markup = renderToStaticMarkup(
      createElement(RecoveryStatusPanel, {
        recovery,
        realtimeStatus: "connecting",
        liveProjectionCount: 0,
        presentation: deriveRunPresentationState(recovery),
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain("Checking availability.");
    expect(markup).not.toContain("Unavailable");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Refresh");
    expect(markup).not.toContain("Retry");
  });

  it("renders aggregate lag and durable completion outcomes without a recent-order panel", () => {
    const recovery = available(projectionFixture());
    const lagMarkup = renderToStaticMarkup(
      createElement(ConsistencyLagPanel, {
        recovery,
        presentation: activePresentation,
        freshness: liveFreshness,
      }),
    );
    const outcomeMarkup = renderToStaticMarkup(
      createElement(RunOutcomesPanel, {
        recovery,
        presentation: activePresentation,
        freshness: liveFreshness,
      }),
    );
    const completionMarkup = renderToStaticMarkup(
      createElement(CompletionOutcomesPanel, { recovery }),
    );

    expect(lagMarkup).toContain("Fast reservation vs final confirmation");
    expect(lagMarkup).toContain("350ms");
    expect(lagMarkup).not.toContain("Latest individual order");
    expect(outcomeMarkup).toContain("Reservation and confirmation summary");
    expect(outcomeMarkup).toContain("System of record");
    expect(outcomeMarkup).toContain("what the API recorded");
    expect(outcomeMarkup).toContain("Unique reservations secured");
    expect(outcomeMarkup).toContain("Confirmed");
    expect(outcomeMarkup).toContain("Failed");
    expect(completionMarkup).toContain("Recent order workflow results");
    expect(completionMarkup).toContain("notification recorded");
    expect(completionMarkup).toContain("ord_recent");
    expect(`${lagMarkup}${outcomeMarkup}${completionMarkup}`).not.toContain(
      "Recent order transitions",
    );
  });

  it.each([
    ["connecting", "connecting to live updates", "connecting", "bg-surface-muted"],
    ["unsupported", "live updates unsupported", "live updates unsupported", "bg-surface-muted"],
  ] as const)("renders %s freshness without a disconnect claim", (state, expectedCopy, expectedLabel, expectedToneClass) => {
    const recovery = available(projectionFixture());
    const markup = renderToStaticMarkup(
      createElement(RequestSurgePanel, {
        recovery,
        liveProjectionCount: 0,
        freshness: { ...liveFreshness, state },
      }),
    );

    expect(markup).toContain(`Updated 12:00:12 AM UTC · ${expectedCopy}`);
    expect(markup).toMatch(
      new RegExp(`${expectedToneClass}[^>]*><span[^>]*>[^<]*</span>${expectedLabel}</span>`),
    );
    expect(markup).not.toContain("disconnected");
    expect(markup).not.toContain("last known values");
  });

  it("renders the request panel's configured delay and remaining harness preparation", () => {
    const projection = projectionFixture();
    if (projection.currentRun?.status !== "active" || !projection.requestArrivalSummary) {
      throw new Error("Expected a run with terminal arrival evidence.");
    }
    const currentRun = projection.currentRun;
    projection.currentRun = {
      ...currentRun,
      configSnapshot: {
        ...currentRun.configSnapshot,
        trafficConfig: {
          ...currentRun.configSnapshot.trafficConfig,
          startDelaySeconds: 3,
        },
      },
      trafficStartedAt: "2026-06-20T00:00:00.000Z",
    };
    projection.requestArrivalSummary = {
      ...projection.requestArrivalSummary,
      firstAttemptStartedAt: "2026-06-20T00:00:10.000Z",
    };

    const markup = renderToStaticMarkup(
      createElement(RequestSurgePanel, {
        recovery: available(projection),
        liveProjectionCount: 1,
        freshness: liveFreshness,
      }),
    );

    expect(markup).toMatch(/Configured start delay<\/dt><dd[^>]*>3s<\/dd>/);
    expect(markup).toMatch(/Remaining harness preparation<\/dt><dd[^>]*>7s<\/dd>/);
  });

  it("separates run ERP outcomes from shared runtime state and labels both clocks", () => {
    const projection = projectionFixture();
    const runMarkup = renderToStaticMarkup(
      createElement(RunErpOutcomesPanel, {
        recovery: available(projection),
        presentation: deriveRunErpOutcomeState(projection.erp),
        freshness: liveFreshness,
      }),
    );
    const systemMarkup = renderToStaticMarkup(
      createElement(SystemStatusPanel, {
        recovery: available(projectionFixture()),
        presentation: deriveSharedRuntimeState(projection.systemStatus),
        erpPresentation: deriveSharedErpProtectionState(
          projection.systemStatus?.erpProtection ?? null,
        ),
      }),
    );

    expect(runMarkup).toContain("This run");
    expect(runMarkup).toMatch(/Run circuit<\/dt><dd[^>]*>open<\/dd>/);
    expect(runMarkup).toContain("Run circuit last changed");
    expect(runMarkup).not.toContain("Shared demo runtime");
    expect(systemMarkup).toContain("Shared demo runtime");
    expect(systemMarkup).toContain("across all runs and visitors");
    expect(systemMarkup).toContain("Circuit state since");
    expect(systemMarkup).toContain("Protection observed");
    expect(systemMarkup).toContain("no scheduled update cadence");
    expect(systemMarkup).not.toContain("Recent attempts");
  });

  it("keeps run attempt evidence visible when circuit state is unavailable", () => {
    const projection = projectionFixture();
    if (!projection.erp) throw new Error("Expected run ERP outcome fixture.");
    projection.erp = {
      ...projection.erp,
      circuit: null,
      circuitReadStatus: "unavailable",
    };

    const markup = renderToStaticMarkup(
      createElement(RunErpOutcomesPanel, {
        recovery: available(projection),
        presentation: deriveRunErpOutcomeState(projection.erp),
        freshness: liveFreshness,
      }),
    );

    expect(markup).toMatch(/Run circuit<\/dt><dd[^>]*>unavailable<\/dd>/);
    expect(markup).toMatch(/Recent attempts<\/dt><dd[^>]*>3<\/dd>/);
    expect(markup).toContain("protection unavailable");
    expect(markup).not.toContain("No ERP outcome data for this run.");
  });

  it("renders a completed exact sellout without warning presentation", () => {
    const projection = projectionFixture();
    if (
      projection.currentRun?.status !== "active" ||
      !projection.inventory ||
      !projection.businessOutcome ||
      !projection.consistencyLag
    ) {
      throw new Error("Expected a complete active projection fixture.");
    }
    const currentRun = projection.currentRun;
    const inventory = projection.inventory;
    const businessOutcome = projection.businessOutcome;
    const consistencyLag = projection.consistencyLag;
    projection.currentRun = {
      ...currentRun,
      status: "completed",
      trafficStatus: "succeeded",
      trafficEndedAt: "2026-06-20T00:00:12.000Z",
      finalizedAt: "2026-06-20T00:00:13.000Z",
    };
    projection.inventory = {
      ...inventory,
      remainingStock: 0,
      reservedStock: 100,
    };
    projection.businessOutcome = {
      ...businessOutcome,
      acceptedReservations: 100,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 100,
      failedOrders: 0,
      pendingPersistenceCount: 0,
    };
    projection.consistencyLag = {
      ...consistencyLag,
      confirmedOrderCount: 100,
      pendingConfirmationCount: 0,
      oldestPendingAgeSeconds: null,
    };
    const recovery = available(projection);
    const runState = deriveRunPresentationState(recovery);
    const freshness = { ...liveFreshness, state: "not-applicable" as const, final: true };
    const markup = [
      renderToStaticMarkup(
        createElement(InventoryDrainPanel, {
          recovery,
          presentation: deriveInventoryOutcomeState(
            projection.inventory,
            projection.currentRun,
            projection.businessOutcome.reservedUnits,
          ),
          freshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(ConsistencyLagPanel, {
          recovery,
          presentation: deriveLagPresentationState(
            projection.consistencyLag.pendingConfirmationCount,
            projection.consistencyLag.confirmedOrderCount,
            projection.currentRun,
          ),
          freshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(RunOutcomesPanel, {
          recovery,
          presentation: deriveOutcomePresentationState(
            projection.businessOutcome,
            projection.currentRun,
            runState,
          ),
          freshness,
        }),
      ),
    ].join("");

    expect(markup).toContain("exact sellout");
    expect(markup).toContain("completed successfully");
    expect(markup).not.toContain("bg-warning-soft");
  });

  it("renders retained inventory values and their update time after disconnect", () => {
    const projection = projectionFixture();
    const markup = renderToStaticMarkup(
      createElement(InventoryDrainPanel, {
        recovery: available(projection),
        presentation: deriveInventoryOutcomeState(
          projection.inventory,
          projection.currentRun,
          projection.businessOutcome?.reservedUnits ?? null,
        ),
        freshness: {
          state: "disconnected",
          observedAt: projection.recoveredAt,
          final: false,
        },
      }),
    );

    expect(markup).toContain("Updated 12:00:11 AM UTC · disconnected, showing last known values");
    expect(markup).toContain("Allocated");
    expect(markup).toContain(">100<");
    expect(markup).toContain("Remaining");
    expect(markup).toContain(">12<");
    expect(markup).toContain("Reserved");
    expect(markup).toContain(">88<");
  });
});

const activePresentation: PresentationState = {
  state: "accepting-checkout-attempts",
  tone: "progress",
  label: "accepting checkout attempts",
  description: "Checkout attempts are being accepted.",
};

const liveFreshness: Freshness = {
  state: "live",
  observedAt: "2026-06-20T00:00:12.000Z",
  final: false,
};

function available(data: DashboardProjection) {
  return { status: "available" as const, data, httpStatus: 200 };
}

function projectionFixture(): DashboardProjection {
  const runId = "11111111-1111-4111-8111-111111111111";
  const saleOfferId = "33333333-3333-4333-8333-333333333333";
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    scopeId: dashboardProjectionScopeId({ runId, saleOfferId }),
    revision: 4,
    correlationId: "corr-web-recovery",
    scope: { runId, saleOfferId },
    currentRun: {
      runId,
      presetId: "22222222-2222-4222-8222-222222222222",
      presetName: "Preview 1k",
      operatorMode: "public",
      status: "active",
      trafficStatus: "active",
      saleOfferId,
      configSnapshot: {
        inventoryConfig: {
          startingStock: 100,
          quantityPerCheckout: 1,
          reservationHoldMinutes: 15,
        },
        trafficConfig: {
          mode: "buyer-spike",
          buyerCount: 1_000,
          duplicateEachBuyerAttempt: false,
          startDelaySeconds: 0,
          maxDurationSeconds: 10,
          quantityPerAttempt: 1,
        },
        erpConfig: {
          latencyMs: 100,
          maxTps: 2,
          errorRate: 0,
          forcedOutage: false,
          requestTimeoutMs: 1_000,
        },
        backpressureConfig: {
          queueName: "orders:process",
          physicalQueueName: "orders-process",
          orderProcessConcurrency: 4,
          retryPolicy: { maxAttempts: 3, initialBackoffMs: 100 },
          drainTimeoutSeconds: 300,
          pendingPersistenceRetryAfterSeconds: 30,
          circuitBreakerFailureThreshold: 5,
          circuitBreakerResetTimeoutMs: 10_000,
        },
      },
      startedAt: "2026-06-20T00:00:00.000Z",
      trafficStartedAt: "2026-06-20T00:00:00.000Z",
    },
    inventory: {
      saleOfferId,
      allocatedStock: 100,
      remainingStock: 12,
      reservedStock: 88,
      pendingPersistenceCount: 0,
      expiredReservationCount: 0,
      oldestPendingPersistenceAgeSeconds: 0,
      reservationThroughput: {
        windowSeconds: 60,
        successfulReservationCount: 88,
        peakRatePerSecond: 88,
        peakWindowSeconds: 1,
        unit: "reservations_per_second",
        measuredAt: "2026-06-20T00:00:11.000Z",
      },
      soldOutPressure: { rejectionCount: 0, latestObservedAt: null },
      observedAt: "2026-06-20T00:00:12.000Z",
      lastUpdatedAt: "2026-06-20T00:00:11.000Z",
    },
    recentMetrics: [
      {
        metricName: "traffic.request_arrival_rate",
        value: 12.5,
        unit: "requests_per_second",
        timestamp: "2026-06-20T00:00:11.000Z",
      },
      {
        metricName: "traffic.latency",
        value: 42,
        unit: "ms",
        timestamp: "2026-06-20T00:00:11.000Z",
      },
      {
        metricName: "traffic.failure_rate",
        value: 0.25,
        unit: "ratio",
        timestamp: "2026-06-20T00:00:11.000Z",
      },
    ],
    erp: {
      runId,
      circuit: {
        state: "open",
        consecutiveFailureCount: 5,
        failureThreshold: 5,
        resetTimeoutMs: 10_000,
        openedAt: "2026-06-20T00:00:09.000Z",
        nextAttemptAt: "2026-06-20T00:00:19.000Z",
        halfOpenProbeInFlight: false,
        lastChangedAt: "2026-06-20T00:00:10.000Z",
      },
      circuitReadStatus: "available",
      latestAttempt: null,
      recentAttemptWindowSeconds: 60,
      recentAttemptCount: 3,
      recentFailureCount: 2,
      recentTimeoutCount: 1,
      observedAt: "2026-06-20T00:00:11.000Z",
    },
    systemStatus: {
      queue: {
        name: "orders:process",
        connectivity: "reachable",
        depth: 2,
        counts: { waiting: 2, prioritized: 0, paused: 0, delayed: 0, active: 0, failed: 0 },
        oldestWaitingAgeSeconds: null,
        retryPressure: {
          inspectedJobCount: 2,
          inspectionLimit: 100,
          retryingJobCount: 1,
          retryAttemptCount: 2,
          inspectionTruncated: false,
        },
        failedJobs: {
          totalCount: 0,
          recent: [],
          inspectionLimit: 20,
          inspectionTruncated: false,
        },
        observedAt: "2026-06-20T00:00:11.000Z",
      },
      erpProtection: {
        status: "degraded",
        reason: "erp_retries_pending",
        circuit: {
          state: "closed",
          consecutiveFailureCount: 0,
          failureThreshold: 5,
          resetTimeoutMs: 10_000,
          openedAt: null,
          nextAttemptAt: null,
          halfOpenProbeInFlight: false,
          lastChangedAt: "2026-06-19T16:00:10.000Z",
        },
        retryPressure: {
          retryingJobCount: 1,
          retryAttemptCount: 2,
          inspectedJobCount: 2,
          inspectionLimit: 100,
          inspectionTruncated: false,
        },
        observedAt: "2026-06-20T00:00:11.000Z",
      },
    },
    businessOutcome: {
      acceptedReservations: 6,
      reservedUnits: 6,
      soldOutRejections: 2,
      queuedOrders: 1,
      processingOrders: 1,
      retryingOrders: 1,
      confirmedOrders: 2,
      failedOrders: 1,
      pendingPersistenceCount: 0,
      notificationsRecorded: 1,
    },
    consistencyLag: {
      confirmedOrderCount: 2,
      pendingConfirmationCount: 3,
      averageLagMs: 225,
      p95LagMs: 350,
      maxLagMs: 375,
      oldestPendingAgeSeconds: 8.5,
      measuredAt: "2026-06-20T00:00:10.000Z",
    },
    recentCompletionOutcomes: [
      {
        orderId: "44444444-4444-4444-8444-444444444444",
        publicOrderId: "ord_recent",
        saleOfferId,
        runId,
        correlationId: "corr-web-recent",
        orderStatus: "confirmed",
        displayStatus: "notification_recorded",
        queuedAt: "2026-06-20T00:00:01.000Z",
        processingAt: "2026-06-20T00:00:02.000Z",
        confirmedAt: "2026-06-20T00:00:03.000Z",
        notificationRecordedAt: "2026-06-20T00:00:04.000Z",
        latestErpAttemptStatus: "succeeded",
        latestEventAt: "2026-06-20T00:00:04.000Z",
      },
    ],
    transportAttemptCounts: {
      plannedRequests: 1_000,
      startedRequests: 900,
      completedRequests: 850,
      interruptedRequests: 50,
      unstartedRequests: 100,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 0,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    requestArrivalSummary: {
      firstAttemptStartedAt: "2026-06-20T00:00:00.000Z",
      peakArrivalRatePerSecond: 1_000,
      peakArrivalWindowSeconds: 1,
      dispatchDurationSeconds: 0.8,
      arrivalRateSeries: [
        {
          windowStartedAt: "2026-06-20T00:00:00.000Z",
          ratePerSecond: 1_000,
        },
      ],
      arrivalWindowCountObserved: 1,
      arrivalWindowCountRetained: 1,
      arrivalSeriesLimit: 120,
    },
    runSignalTimelineSummary: null,
    recoveredAt: "2026-06-20T00:00:11.000Z",
  };
}
