import type { RunHistoryDetailResponse, RunHistoryListResponse } from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunHistoryDetail } from "../src/app/components/run-history-detail.js";
import { RunHistoryList } from "../src/app/components/run-history-list.js";

describe("run history surface", () => {
  it("renders traffic delivery, business outcomes, and terminal inventory snapshots", () => {
    const markup = renderToStaticMarkup(
      createElement(RunHistoryList, { history: runHistoryFixture() }),
    );

    expect(markup).toContain("Preview 1k");
    expect(markup).toContain("55555555-5555-4555-8555-555555555555");
    expect(markup).toContain("traffic complete");
    expect(markup).toContain("Accepted reservations");
    expect(markup).toContain("Confirmed orders");
    expect(markup).toContain("Terminal inventory");
    expect(markup).toContain("Starting stock");
    expect(markup).toContain("redis snapshot captured");
    expect(markup).toContain('href="/run-history/55555555-5555-4555-8555-555555555555"');
    expect(markup).toContain("View details");
  });

  it("renders a clear empty state before terminal summaries exist", () => {
    const markup = renderToStaticMarkup(
      createElement(RunHistoryList, {
        history: {
          summaries: [],
          page: 1,
          pageSize: 10,
          totalCount: 0,
          timestamp: "2026-06-20T00:00:10.000Z",
        },
      }),
    );

    expect(markup).toContain("No history yet");
    expect(markup).toContain("Terminal summaries appear here");
  });

  it("renders public-safe detail without private operational fields", () => {
    const markup = renderToStaticMarkup(
      createElement(RunHistoryDetail, { detail: runHistoryDetailFixture() }),
    );

    expect(markup).toContain("Terminal detail");
    expect(markup).toContain("Accepted configuration");
    expect(markup).toContain("Order outcomes");
    expect(markup).toContain("ord_history_1");
    expect(markup).toContain("ERP attempts");
    expect(markup).toContain("Event timeline");
    expect(markup).not.toContain("reservationToken");
    expect(markup).not.toContain("idempotencyKey");
    expect(markup).not.toContain("payload");
    expect(markup).not.toContain("x-control-service-token");
  });
});

function runHistoryFixture(): RunHistoryListResponse {
  return {
    summaries: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        runId: "55555555-5555-4555-8555-555555555555",
        presetName: "Preview 1k",
        status: "completed",
        startedAt: "2026-06-20T00:00:00.000Z",
        endedAt: "2026-06-20T00:00:10.000Z",
        httpSummary: {
          plannedRequests: 10,
          emittedRequests: 10,
          completedRequests: 10,
          failedRequests: 0,
          acceptedResponses: 6,
          soldOutResponses: 4,
          unexpectedResponses: 0,
          p95LatencyMs: 42,
          failureRate: 0,
        },
        trafficDeliverySummary: {
          plannedRequests: 10,
          emittedRequests: 10,
          droppedIterations: 0,
          trafficDeliveryStatus: "complete",
          notes: [],
        },
        businessOutcomeSummary: {
          acceptedReservations: 6,
          soldOutRejections: 4,
          queuedOrders: 0,
          processingOrders: 0,
          retryingOrders: 0,
          confirmedOrders: 5,
          failedOrders: 1,
          pendingPersistenceCount: 0,
          notificationsRecorded: 5,
        },
        terminalInventorySnapshot: {
          saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          startingStock: 10,
          remainingStock: 0,
          reservedStock: 10,
          acceptedReservations: 6,
          soldOutRejections: 4,
          pendingPersistenceCount: 0,
          capturedAt: "2026-06-20T00:00:10.000Z",
          source: "redis",
        },
        capturedAt: "2026-06-20T00:00:10.000Z",
      },
    ],
    page: 1,
    pageSize: 10,
    totalCount: 1,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function runHistoryDetailFixture(): RunHistoryDetailResponse {
  const summary = runHistoryFixture().summaries[0];
  if (!summary) {
    throw new Error("Expected run history summary fixture.");
  }

  return {
    summary,
    run: {
      runId: summary.runId,
      presetId: "33333333-3333-4333-8333-333333333333",
      presetName: summary.presetName,
      operatorMode: "public",
      status: "completed",
      trafficStatus: "succeeded",
      saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      configSnapshot: {
        trafficConfig: {
          mode: "buyer-spike",
          buyerCount: 10,
          duplicateEachBuyerAttempt: false,
          startDelaySeconds: 0,
          maxDurationSeconds: 1,
          quantityPerAttempt: 1,
        },
        inventoryConfig: {
          startingStock: 10,
          quantityPerCheckout: 1,
          reservationHoldMinutes: 15,
        },
        erpConfig: {
          latencyMs: 10,
          maxTps: 10,
          errorRate: 0,
          forcedOutage: false,
          requestTimeoutMs: 1000,
        },
        backpressureConfig: {
          queueName: "orders:process",
          physicalQueueName: "orders-process",
          orderProcessConcurrency: 2,
          drainTimeoutSeconds: 300,
          pendingPersistenceRetryAfterSeconds: 30,
          circuitBreakerFailureThreshold: 5,
          circuitBreakerResetTimeoutMs: 10_000,
        },
      },
      startedAt: "2026-06-20T00:00:00.000Z",
      trafficStartedAt: "2026-06-20T00:00:01.000Z",
      trafficEndedAt: "2026-06-20T00:00:09.000Z",
      finalizedAt: "2026-06-20T00:00:10.000Z",
    },
    orders: {
      totalCount: 1,
      limit: 20,
      truncated: false,
      records: [
        {
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          correlationId: "corr-history-detail",
          quantity: 1,
          status: "confirmed",
          queuedAt: "2026-06-20T00:00:02.000Z",
          processingAt: "2026-06-20T00:00:03.000Z",
          confirmedAt: "2026-06-20T00:00:07.000Z",
        },
      ],
    },
    erpAttempts: {
      totalCount: 1,
      limit: 20,
      truncated: false,
      records: [
        {
          attemptId: "99999999-9999-4999-8999-999999999992",
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          correlationId: "corr-history-detail",
          attemptNumber: 1,
          status: "succeeded",
          httpStatus: 200,
          latencyMs: 42,
          startedAt: "2026-06-20T00:00:04.000Z",
          finishedAt: "2026-06-20T00:00:05.000Z",
        },
      ],
    },
    notifications: {
      totalCount: 1,
      limit: 20,
      truncated: false,
      records: [
        {
          notificationId: "99999999-9999-4999-8999-999999999993",
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          channel: "email",
          status: "recorded",
          recordedAt: "2026-06-20T00:00:08.000Z",
        },
      ],
    },
    eventTimeline: {
      totalCount: 1,
      limit: 20,
      truncated: false,
      records: [
        {
          eventId: "99999999-9999-4999-8999-999999999994",
          eventName: "order.confirmed",
          source: "worker",
          saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          correlationId: "corr-history-detail",
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          occurredAt: "2026-06-20T00:00:07.000Z",
        },
      ],
    },
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}
