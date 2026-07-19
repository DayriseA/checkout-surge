import type {
  AdminRunHistoryDetailResponse,
  RunHistoryDetailResponse,
  RunHistoryListResponse,
} from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminRunHistoryDetail,
  PublicRunHistoryDetail,
} from "../src/app/components/run-history-detail.js";
import { RunHistoryList } from "../src/app/components/run-history-list.js";
import RunHistoryDetailPage from "../src/app/run-history/[runId]/page.js";

const getRunHistoryDetail = vi.hoisted(() => vi.fn());
const getAdminRunHistoryDetail = vi.hoisted(() => vi.fn());
const hasValidAdminPageSession = vi.hoisted(() => vi.fn());

vi.mock("../src/app/lib/api.js", () => ({ getRunHistoryDetail, getAdminRunHistoryDetail }));
vi.mock("../src/app/lib/server/admin-page-session.js", () => ({ hasValidAdminPageSession }));

describe("run history surface", () => {
  beforeEach(() => {
    getRunHistoryDetail.mockReset();
    getAdminRunHistoryDetail.mockReset();
    hasValidAdminPageSession.mockResolvedValue(false);
  });

  it("renders traffic delivery, business outcomes, and terminal inventory snapshots", () => {
    const markup = renderToStaticMarkup(
      createElement(RunHistoryList, { history: runHistoryFixture() }),
    );

    expect(markup).toContain("Preview 1k");
    expect(markup).toContain("55555555-5555-4555-8555-555555555555");
    expect(markup).toContain("traffic complete");
    expect(markup).toContain("Planned");
    expect(markup).toContain("Started");
    expect(markup).toContain("Responses completed");
    expect(markup).toContain("Interrupted");
    expect(markup).toContain("Unstarted");
    expect(markup).not.toContain("Emitted");
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

  it("distinguishes an out-of-range page from globally empty history", () => {
    const markup = renderToStaticMarkup(
      createElement(RunHistoryList, {
        history: {
          summaries: [],
          page: 2,
          pageSize: 10,
          totalCount: 7,
          timestamp: "2026-06-20T00:00:10.000Z",
        },
      }),
    );

    expect(markup).toContain("Page 2 has no summaries");
    expect(markup).toContain("7 summaries exist");
    expect(markup).toContain('href="/run-history"');
    expect(markup).toContain("View latest summaries");
    expect(markup).not.toContain("No history yet");
  });

  it("renders public-safe detail without private operational fields", () => {
    const markup = renderToStaticMarkup(
      createElement(PublicRunHistoryDetail, { detail: runHistoryDetailFixture() }),
    );

    expect(markup).toContain("Terminal detail");
    expect(markup).toContain("Responses completed");
    expect(markup).toContain("Interrupted");
    expect(markup).toContain("Unstarted");
    expect(markup).toContain("p95 latency");
    expect(markup).not.toContain("Emitted");
    expect(markup).toMatch(/Planned<\/dt><dd[^>]*>10<\/dd>/);
    expect(markup).toMatch(/Started<\/dt><dd[^>]*>9<\/dd>/);
    expect(markup).toMatch(/Responses completed<\/dt><dd[^>]*>7<\/dd>/);
    expect(markup).toMatch(/Interrupted<\/dt><dd[^>]*>2<\/dd>/);
    expect(markup).toMatch(/Unstarted<\/dt><dd[^>]*>1<\/dd>/);
    expect(markup).toMatch(/Accepted<\/dt><dd[^>]*>4<\/dd>/);
    expect(markup).toMatch(/Sold out<\/dt><dd[^>]*>3<\/dd>/);
    expect(markup).toMatch(/Unexpected<\/dt><dd[^>]*>0<\/dd>/);
    expect(markup).toMatch(/p95 latency<\/dt><dd[^>]*>42ms<\/dd>/);
    expect(markup).toContain("Accepted configuration");
    expect(markup).toContain("Order aggregates");
    expect(markup).toContain("ERP aggregates");
    expect(markup).toContain("Public activity totals");
    expect(markup).not.toContain("ord_history_1");
    expect(markup).not.toContain("corr-history-detail");
    expect(markup).not.toContain("worker");
    expect(markup).not.toContain("reservationToken");
    expect(markup).not.toContain("idempotencyKey");
    expect(markup).not.toContain("payload");
    expect(markup).not.toContain("x-control-service-token");
  });

  it("retains row detail in the admin representation", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminRunHistoryDetail, { detail: adminRunHistoryDetailFixture() }),
    );
    expect(markup).toContain("Order outcomes");
    expect(markup).toContain("ord_history_1");
    expect(markup).toContain("Event timeline");
    expect(markup).toContain("worker");
    expect(markup).toContain("Responses completed");
    expect(markup).toContain("Interrupted");
    expect(markup).toContain("Unstarted");
    expect(markup).not.toContain("Emitted");
  });

  it("renders malformed detail routes as public-safe not-found states without an API read", async () => {
    const page = await RunHistoryDetailPage({
      params: Promise.resolve({ runId: "not-a-real-run" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Run not found");
    expect(markup).toContain("No terminal summary exists for this run.");
    expect(markup).toContain("not found");
    expect(markup).not.toContain("Detail unavailable");
    expect(markup).not.toContain("Invalid UUID");
    expect(markup).not.toContain("validation");
    expect(markup).not.toContain("runId&quot;");
    expect(getRunHistoryDetail).not.toHaveBeenCalled();
  });

  it("preserves backend-unavailable detail rendering for valid run IDs", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    getRunHistoryDetail.mockResolvedValue({
      status: "unavailable",
      reason: "backend offline",
    });

    const page = await RunHistoryDetailPage({ params: Promise.resolve({ runId }) });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Detail unavailable");
    expect(markup).toContain("backend offline");
    expect(markup).not.toContain("Run not found");
    expect(getRunHistoryDetail).toHaveBeenCalledOnce();
    expect(getRunHistoryDetail).toHaveBeenCalledWith(runId);
  });

  it("selects admin detail only from the validated page session", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    hasValidAdminPageSession.mockResolvedValue(true);
    getAdminRunHistoryDetail.mockResolvedValue({
      status: "available",
      data: adminRunHistoryDetailFixture(),
      httpStatus: 200,
    });

    const page = await RunHistoryDetailPage({ params: Promise.resolve({ runId }) });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("ord_history_1");
    expect(getAdminRunHistoryDetail).toHaveBeenCalledWith(runId);
    expect(getRunHistoryDetail).not.toHaveBeenCalled();
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
          startedRequests: 10,
          completedRequests: 10,
          interruptedRequests: 0,
          unstartedRequests: 0,
          failedRequests: 0,
          acceptedResponses: 6,
          soldOutResponses: 4,
          unexpectedResponses: 0,
          p95LatencyMs: 42,
          failureRate: 0,
        },
        trafficDeliverySummary: {
          plannedRequests: 10,
          startedRequests: 10,
          completedRequests: 10,
          interruptedRequests: 0,
          unstartedRequests: 0,
          trafficMode: null,
          plannedBuyers: null,
          scheduledRatePerSecond: null,
          configuredDurationSeconds: null,
          preAllocatedVUs: null,
          maxVUs: null,
          droppedIterations: 0,
          completedIterations: null,
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
  const admin = adminRunHistoryDetailFixture();
  const { id: _id, terminalInventorySnapshot, ...summary } = admin.summary;
  const { presetId: _presetId, saleOfferId: _saleOfferId, ...run } = admin.run;
  const sanitizedInventory = terminalInventorySnapshot
    ? (({ saleOfferId: _inventorySaleOfferId, source: _inventorySource, ...inventory }) =>
        inventory)(terminalInventorySnapshot)
    : undefined;
  const { notes: _deliveryNotes, ...publicDeliverySummary } = summary.trafficDeliverySummary;
  const transportCounts = {
    plannedRequests: 10,
    startedRequests: 9,
    completedRequests: 7,
    interruptedRequests: 2,
    unstartedRequests: 1,
  };
  return {
    summary: {
      ...summary,
      httpSummary: {
        ...summary.httpSummary,
        ...transportCounts,
        acceptedResponses: 4,
        soldOutResponses: 3,
        unexpectedResponses: 0,
      },
      trafficDeliverySummary: {
        ...publicDeliverySummary,
        ...transportCounts,
        completedIterations: 7,
        trafficDeliveryStatus: "failed",
      },
      ...(sanitizedInventory ? { terminalInventorySnapshot: sanitizedInventory } : {}),
    },
    run,
    orders: { totalCount: 1, byStatus: { queued: 0, processing: 0, confirmed: 1, failed: 0 } },
    erpAttempts: {
      totalCount: 1,
      byStatus: { succeeded: 1, failed: 0, timedOut: 0 },
      averageLatencyMs: 42,
      p95LatencyMs: 42,
    },
    notifications: { totalCount: 1 },
    events: { totalCount: 1 },
    timestamp: admin.timestamp,
  };
}

function adminRunHistoryDetailFixture(): AdminRunHistoryDetailResponse {
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
          retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
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
          terminal: true,
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
