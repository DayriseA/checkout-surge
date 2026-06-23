import type { DashboardEvent, DashboardRecoveryResponse } from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CompletionOutcomesPanel,
  ConsistencyLagPanel,
  LoadRunControlsPanel,
  RunOutcomesPanel,
} from "../src/app/components/dashboard-panels.js";
import { applyDashboardEvent } from "../src/app/components/operator-dashboard.js";
import type { BackendRead } from "../src/app/lib/api.js";

describe("Phase 6 dashboard behavior", () => {
  it("renders enabled run controls when Phase 7 start handling is available", () => {
    const markup = renderToStaticMarkup(
      createElement(LoadRunControlsPanel, {
        recovery: availableRecovery(recoveryFixture()),
        onStartPreset: async () => ({
          status: "available" as const,
          data: {
            run: runFixture(),
            recovery: { establishedAt: "2026-06-20T00:00:10.000Z" },
            correlationId: "corr-web-start",
            timestamp: "2026-06-20T00:00:10.000Z",
          },
          httpStatus: 202,
        }),
      }),
    );

    expect(markup).toContain("ready");
    expect(markup).toContain("Ready to start bounded public traffic.");
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain("preview-1k");
    expect(markup).toContain("public-custom");
  });

  it("renders current-run start gating when recovery reports an active run", () => {
    const markup = renderToStaticMarkup(
      createElement(LoadRunControlsPanel, {
        recovery: availableRecovery({
          ...recoveryFixture(),
          currentRun: {
            runId: "11111111-1111-4111-8111-111111111111",
            presetId: "22222222-2222-4222-8222-222222222222",
            presetName: "Surge 5k",
            operatorMode: "public",
            status: "active",
            trafficStatus: "active",
            configSnapshot: {
              trafficConfig: {},
              inventoryConfig: {},
              erpConfig: {},
              backpressureConfig: {},
            },
            saleOfferId: "33333333-3333-4333-8333-333333333333",
            startedAt: "2026-06-20T00:00:00.000Z",
          },
        } as DashboardRecoveryResponse),
      }),
    );

    expect(markup).toContain("active");
    expect(markup).toContain("A run is already starting, active, or draining.");
  });

  it("renders consistency-lag and run outcome projections for operator review", () => {
    const recovery = availableRecovery(recoveryFixture());
    const lagMarkup = renderToStaticMarkup(createElement(ConsistencyLagPanel, { recovery }));
    const outcomeMarkup = renderToStaticMarkup(createElement(RunOutcomesPanel, { recovery }));
    const completionMarkup = renderToStaticMarkup(
      createElement(CompletionOutcomesPanel, { recovery }),
    );

    expect(lagMarkup).toContain("Fast reservation vs final confirmation");
    expect(lagMarkup).toContain("350ms");
    expect(lagMarkup).toContain("Pending");
    expect(outcomeMarkup).toContain("Reservation and confirmation summary");
    expect(outcomeMarkup).toContain("Accepted");
    expect(outcomeMarkup).toContain("Confirmed");
    expect(outcomeMarkup).toContain("Failed");
    expect(completionMarkup).toContain("Recent order workflow results");
    expect(completionMarkup).toContain("notification recorded");
    expect(completionMarkup).toContain("ord_recent");
  });

  it("applies live business-outcome events over the recovery baseline", () => {
    const event: DashboardEvent = {
      type: "business.outcome.updated",
      eventId: "44444444-4444-4444-8444-444444444444",
      saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      correlationId: "corr-web-live",
      occurredAt: "2026-06-20T00:00:11.000Z",
      outcome: {
        acceptedReservations: 9,
        soldOutRejections: 3,
        queuedOrders: 2,
        processingOrders: 1,
        retryingOrders: 1,
        confirmedOrders: 4,
        failedOrders: 1,
        pendingPersistenceCount: 0,
        notificationsRecorded: 0,
      },
      consistencyLag: {
        confirmedOrderCount: 4,
        pendingConfirmationCount: 4,
        averageLagMs: 275,
        p95LagMs: 425,
        maxLagMs: 500,
        oldestPendingAgeSeconds: 7,
        measuredAt: "2026-06-20T00:00:11.000Z",
      },
    };

    const next = applyDashboardEvent(availableRecovery(recoveryFixture()), event);

    expect(next.status).toBe("available");
    if (next.status !== "available") {
      throw new Error("Expected available recovery after applying a live event.");
    }
    expect(next.data.businessOutcome).toEqual(event.outcome);
    expect(next.data.consistencyLag).toEqual(event.consistencyLag);
  });
});

function availableRecovery(
  data: DashboardRecoveryResponse,
): BackendRead<DashboardRecoveryResponse> {
  return { status: "available", data, httpStatus: 200 };
}

function runFixture() {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Preview 1k",
    operatorMode: "public" as const,
    status: "active" as const,
    trafficStatus: "active" as const,
    configSnapshot: {
      trafficConfig: {
        mode: "buyer-spike" as const,
        buyerCount: 1000,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 2,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 250,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
      erpConfig: {
        latencyMs: 80,
        maxTps: 250,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: {
        queueName: "orders:process" as const,
        physicalQueueName: "orders-process" as const,
        orderProcessConcurrency: 5,
        drainTimeoutSeconds: 300,
        pendingPersistenceRetryAfterSeconds: 30,
      },
    },
    saleOfferId: "33333333-3333-4333-8333-333333333333",
    startedAt: "2026-06-20T00:00:00.000Z",
  };
}

function recoveryFixture(): DashboardRecoveryResponse {
  return {
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: {
      acceptedReservations: 6,
      soldOutRejections: 2,
      queuedOrders: 1,
      processingOrders: 1,
      retryingOrders: 1,
      confirmedOrders: 2,
      failedOrders: 1,
      pendingPersistenceCount: 0,
      notificationsRecorded: 0,
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
        orderId: "11111111-1111-4111-8111-111111111111",
        publicOrderId: "ord_recent",
        saleOfferId: "33333333-3333-4333-8333-333333333333",
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
    recoveredAt: "2026-06-20T00:00:10.000Z",
  };
}
