import type {
  AdminRunHistoryDetailResponse,
  PublicRunHistoryDetailResponse,
  RunHistoryListResponse,
} from "@checkout-surge/contracts";
import {
  emptyRequestArrivalSummary,
  evaluateFastReservationTarget,
  type ServerReservationTimingSummary,
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
const serverReservationTimingSummary: ServerReservationTimingSummary = {
  redisAtomicReservation: { sampleCount: 10, averageMs: 0.7, p95Ms: 1 },
  reserveOrderService: { sampleCount: 10, averageMs: 12, p95Ms: 25 },
};
const httpTimingBreakdownSummary: PublicRunHistoryDetailResponse["httpTimingBreakdownSummary"] = {
  blocked: { averageMs: 2, p95Ms: 5 },
  connecting: { averageMs: 1, p95Ms: 4 },
  tlsHandshaking: { averageMs: 0, p95Ms: 0 },
  sending: { averageMs: 0.2, p95Ms: 1 },
  waiting: { averageMs: 30, p95Ms: 42 },
  receiving: { averageMs: 0.1, p95Ms: 0.5 },
};

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
    expect(markup).toContain("Request arrival");
    expect(markup).toContain("10 attempts/s");
    expect(markup).toContain("1-second window");
    expect(markup).toContain("Load generator");
    expect(markup).toContain("what k6 observed");
    expect(markup).toContain("Planned attempts");
    expect(markup).toContain("Dispatched");
    expect(markup).toContain("Replies recorded");
    expect(markup).toContain("Replies not recorded");
    expect(markup).toContain("Never dispatched");
    expect(markup).not.toContain("Interrupted");
    expect(markup).not.toContain("Unstarted");
    expect(markup).not.toContain("Emitted");
    // This run recorded every reply, so coverage and the survivorship caveat stay hidden.
    expect(markup).not.toContain("recorded a reply");
    expect(markup).not.toContain("Outcomes and latency");
    expect(markup).toContain("System of record");
    expect(markup).toContain("what the API recorded");
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
    expect(markup).toContain("Load generator");
    expect(markup).toContain("what k6 observed");
    expect(markup).toContain("Observed outcomes");
    expect(markup).toContain("p95 latency");
    expect(markup).not.toContain("Interrupted");
    expect(markup).not.toContain("Unstarted");
    expect(markup).not.toContain("Emitted");
    expect(markup).toMatch(/Planned attempts<\/dt><dd[^>]*>10<\/dd>/);
    expect(markup).toMatch(/Dispatched<\/dt><dd[^>]*>9<\/dd>/);
    expect(markup).toMatch(/Replies recorded<\/dt><dd[^>]*>7<\/dd>/);
    expect(markup).toMatch(
      /Replies not recorded<span[^>]*>generator shut down before the reply arrived<\/span><\/dt><dd[^>]*>2<\/dd>/,
    );
    expect(markup).toMatch(
      /Never dispatched<span[^>]*>scenario window closed before these were sent<\/span><\/dt><dd[^>]*>1<\/dd>/,
    );
    expect(markup).toMatch(/Accepted<\/dt><dd[^>]*>4<\/dd>/);
    expect(markup).toMatch(/Sold out<\/dt><dd[^>]*>3<\/dd>/);
    expect(markup).toMatch(/Unexpected<\/dt><dd[^>]*>0<\/dd>/);
    expect(markup).toMatch(
      /Client HTTP p95<span[^>]*>observed replies only<\/span><\/dt><dd[^>]*>42ms<\/dd>/,
    );
    // 7 of 9 dispatched attempts recorded a reply.
    expect(markup).toContain("78% of dispatched attempts recorded a reply");
    expect(markup).toContain(
      "Outcomes and latency above cover 7 of 10 attempts. The p95 describes replies received only. Server-side totals are the authoritative record.",
    );
    expect(markup).toContain("Accepted configuration");
    expect(markup).toContain("Order aggregates");
    expect(markup).toContain("ERP aggregates");
    expect(markup).toContain("Public activity totals");
    expect(markup).not.toContain("Generator diagnostics");
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
    expect(markup).toContain("Load generator");
    expect(markup).toContain("Replies recorded");
    expect(markup).toContain("Replies not recorded");
    expect(markup).toContain("Never dispatched");
    expect(markup).toContain("System of record");
    expect(markup).toContain("Generator diagnostics");
    expect(markup).toContain("k6 v1.0.0");
    expect(markup).toContain("Client-observed HTTP phases");
    expect(markup).toContain("Waiting p95");
    expect(markup).not.toContain("Interrupted");
    expect(markup).not.toContain("Unstarted");
    expect(markup).not.toContain("Emitted");
    expect(markup).not.toContain("Outcomes and latency");
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
    expect(getAdminRunHistoryDetail).not.toHaveBeenCalled();
  });

  it("keeps diagnostics behind the validated admin page session", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    getRunHistoryDetail.mockResolvedValue({
      status: "available",
      data: runHistoryDetailFixture(),
      httpStatus: 200,
    });

    const page = await RunHistoryDetailPage({ params: Promise.resolve({ runId }) });
    const markup = renderToStaticMarkup(page);

    expect(markup).not.toContain("Generator diagnostics");
    expect(getRunHistoryDetail).toHaveBeenCalledWith(runId);
    expect(getAdminRunHistoryDetail).not.toHaveBeenCalled();
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
        transportAttemptCounts: {
          plannedRequests: 10,
          startedRequests: 10,
          completedRequests: 10,
          interruptedRequests: 0,
          unstartedRequests: 0,
        },
        httpSummary: {
          failedRequests: 0,
          acceptedResponses: 6,
          soldOutResponses: 4,
          transportFailures: 0,
          unexpectedResponses: 0,
          p95LatencyMs: 42,
          failureRate: 0,
        },
        trafficDeliverySummary: {
          trafficMode: null,
          plannedBuyers: null,
          scheduledRatePerSecond: null,
          configuredDurationSeconds: null,
          preAllocatedVUs: null,
          maxVUs: null,
          droppedIterations: 0,
          completedIterations: null,
          requestArrivalSummary: {
            ...emptyRequestArrivalSummary,
            peakArrivalRatePerSecond: 10,
            dispatchDurationSeconds: 0.2,
            arrivalRateSeries: [
              {
                windowStartedAt: "2026-06-20T00:00:00.000Z",
                ratePerSecond: 10,
              },
            ],
            arrivalWindowCountObserved: 1,
            arrivalWindowCountRetained: 1,
          },
          trafficDeliveryStatus: "complete",
          notes: [],
        },
        serverReservationTimingSummary,
        fastReservationTargetEvaluation: evaluateFastReservationTarget(
          serverReservationTimingSummary,
          10,
        ),
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

function runHistoryDetailFixture(): PublicRunHistoryDetailResponse {
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
      transportAttemptCounts: transportCounts,
      httpSummary: {
        ...summary.httpSummary,
        acceptedResponses: 4,
        soldOutResponses: 3,
        unexpectedResponses: 0,
      },
      trafficDeliverySummary: {
        ...publicDeliverySummary,
        completedIterations: 7,
        trafficDeliveryStatus: "failed",
      },
      fastReservationTargetEvaluation: evaluateFastReservationTarget(
        serverReservationTimingSummary,
        7,
      ),
      ...(sanitizedInventory ? { terminalInventorySnapshot: sanitizedInventory } : {}),
    },
    run,
    httpTimingBreakdownSummary,
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
    httpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: runDiagnosticsFixture(),
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

function runDiagnosticsFixture(): AdminRunHistoryDetailResponse["loadRunDiagnosticsSummary"] {
  return {
    startedAt: "2026-06-20T00:00:01.000Z",
    completedAt: "2026-06-20T00:00:09.000Z",
    nproc: 8,
    ulimitNofile: 1_048_576,
    processMaxOpenFiles: { soft: 1_048_576, hard: 1_048_576 },
    generatorCapacity: null,
    generatorUtilisation: null,
    networkDiagnostics: null,
    k6Version: "k6 v1.0.0",
    executionPlan: {
      trafficMode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      iterationsPerVu: 1,
      plannedEmittedAttempts: 10,
      startDelaySeconds: 0,
      maxDurationSeconds: 1,
    },
    stderrLines: [],
    stderrLineCountObserved: 0,
    stderrLineCountRetained: 0,
    stderrRetainedLineLimit: 50,
    stderrLineTruncationLength: 500,
    stderrLineTruncatedCount: 0,
    terminalMetricSources: {
      startedRequests: "summary_export",
      completedRequests: "summary_export",
      acceptedResponses: "summary_export",
      soldOutResponses: "summary_export",
      transportFailures: "summary_export",
      unexpectedResponses: "summary_export",
      droppedIterations: "summary_export",
      completedIterations: "summary_export",
    },
    summaryExportWarnings: [],
  };
}
