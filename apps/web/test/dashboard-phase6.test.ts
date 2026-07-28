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
  ErpHealthPanel,
  InventoryDrainPanel,
  QueuePressurePanel,
  RequestSurgePanel,
  RunOutcomesPanel,
} from "../src/app/components/dashboard-panels.js";

describe("Phase 6 projection dashboard", () => {
  it("renders aggregate lag and durable completion outcomes without a recent-order panel", () => {
    const recovery = available(projectionFixture());
    const lagMarkup = renderToStaticMarkup(createElement(ConsistencyLagPanel, { recovery }));
    const outcomeMarkup = renderToStaticMarkup(createElement(RunOutcomesPanel, { recovery }));
    const completionMarkup = renderToStaticMarkup(
      createElement(CompletionOutcomesPanel, { recovery }),
    );

    expect(lagMarkup).toContain("Fast reservation vs final confirmation");
    expect(lagMarkup).toContain("350ms");
    expect(lagMarkup).not.toContain("Latest individual order");
    expect(outcomeMarkup).toContain("Reservation and confirmation summary");
    expect(outcomeMarkup).toContain("System of record");
    expect(outcomeMarkup).toContain("what the API recorded");
    expect(outcomeMarkup).toContain("Accepted");
    expect(outcomeMarkup).toContain("Confirmed");
    expect(outcomeMarkup).toContain("Failed");
    expect(completionMarkup).toContain("Recent order workflow results");
    expect(completionMarkup).toContain("notification recorded");
    expect(completionMarkup).toContain("ord_recent");
    expect(`${lagMarkup}${outcomeMarkup}${completionMarkup}`).not.toContain(
      "Recent order transitions",
    );
  });

  it("presents all four gold signals and producer freshness from one projection", () => {
    const recovery = available(projectionFixture());
    const traffic = renderToStaticMarkup(
      createElement(RequestSurgePanel, { recovery, liveProjectionCount: 3 }),
    );
    const inventory = renderToStaticMarkup(createElement(InventoryDrainPanel, { recovery }));
    const queue = renderToStaticMarkup(createElement(QueuePressurePanel, { recovery }));
    const erp = renderToStaticMarkup(createElement(ErpHealthPanel, { recovery }));
    const lag = renderToStaticMarkup(createElement(ConsistencyLagPanel, { recovery }));

    expect(traffic).toContain("Observed HTTP request rate");
    expect(traffic).toContain("12.5 requests/s");
    expect(traffic).toContain("Window mean HTTP latency");
    expect(traffic).toContain("Window HTTP failure rate");
    expect(traffic).toContain("25%");
    expect(traffic).toContain("Load generator");
    expect(traffic).toContain("Planned attempts");
    expect(traffic).toContain("1,000");
    // 850 of 900 dispatched attempts recorded a reply, and 100 were never sent.
    expect(traffic).toContain("94% of dispatched attempts recorded a reply");
    expect(traffic).toContain("generator shut down before the reply arrived");
    expect(traffic).toContain("scenario window closed before these were sent");
    expect(traffic).toContain("Reply-dependent outcomes and latency cover 850 of 1,000 attempts.");
    expect(inventory).toContain("Inventory updated");
    expect(queue).toContain("Queue inspected");
    expect(erp).toContain("Failure threshold");
    expect(lag).toContain("p95 confirmed");
  });
});

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
        rate: 1.47,
        unit: "reservations_per_second",
        measuredAt: "2026-06-20T00:00:11.000Z",
      },
      soldOutPressure: { rejectionCount: 0, latestObservedAt: null },
      lastUpdatedAt: "2026-06-20T00:00:11.000Z",
    },
    recentMetrics: [
      {
        metricName: "traffic.scheduled_request_rate",
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
    queue: {
      name: "orders:process",
      connectivity: "reachable",
      depth: 2,
      counts: { waiting: 2, prioritized: 0, paused: 0, delayed: 0, active: 0, failed: 0 },
      oldestWaitingAgeSeconds: null,
      retryPressure: {
        inspectedJobCount: 2,
        inspectionLimit: 100,
        retryingJobCount: 0,
        retryAttemptCount: 0,
        inspectionTruncated: false,
      },
      failedJobs: { totalCount: 0, recent: [], inspectionLimit: 20, inspectionTruncated: false },
      updatedAt: "2026-06-20T00:00:11.000Z",
    },
    erp: {
      status: "degraded",
      reason: "recent_erp_failures",
      circuit: {
        state: "open",
        consecutiveFailureCount: 5,
        failureThreshold: 5,
        resetTimeoutMs: 10_000,
        openedAt: "2026-06-20T00:00:09.000Z",
        nextAttemptAt: "2026-06-20T00:00:19.000Z",
        halfOpenProbeInFlight: false,
        updatedAt: "2026-06-20T00:00:10.000Z",
      },
      retryPressure: {
        retryingJobCount: 1,
        retryAttemptCount: 2,
        inspectedJobCount: 2,
        inspectionLimit: 100,
        inspectionTruncated: false,
      },
      latestAttempt: null,
      recentAttemptWindowSeconds: 60,
      recentAttemptCount: 3,
      recentFailureCount: 2,
      recentTimeoutCount: 1,
      confirmationDelay: {
        processingOrderCount: 1,
        oldestProcessingAgeSeconds: 2,
        recentConfirmedCount: 1,
        averageConfirmationDelayMs: 80,
      },
      updatedAt: "2026-06-20T00:00:11.000Z",
    },
    businessOutcome: {
      acceptedReservations: 6,
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
    recoveredAt: "2026-06-20T00:00:11.000Z",
  };
}
