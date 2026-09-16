import {
  deriveRunResult,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  emptyServerReservationTimingSummary,
  errorPayloadSchema,
  evaluateFastReservationTarget,
} from "@checkout-surge/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getPublicRunHistoryDetail } from "../src/app/api/demo/runs/history/[runId]/route.js";
import {
  getPublicDemoSurface,
  getRunHistoryDetail,
  getRunHistoryPage,
} from "../src/app/lib/api.js";
import {
  initializeWebServerConfig,
  resetWebServerConfigForTests,
} from "../src/app/lib/server/config.js";
import WatchPage from "../src/app/watch/page.js";

vi.mock("../src/app/lib/server/page-view-mode.js", () => ({
  readPageViewMode: vi.fn(async () => "basic" as const),
}));

const originalEnv = { ...process.env };
const validWebEnv = {
  CONTROL_SERVICE_TOKEN: "control-token",
  ADMIN_DASHBOARD_PASSPHRASE: "admin-passphrase",
  ADMIN_SESSION_SECRET: "session-secret",
  PUBLIC_CLIENT_COOKIE_SECRET: "visitor-cookie-secret",
  WEB_ORIGIN: "http://dashboard.local",
};

describe("dashboard backend API reads", () => {
  beforeEach(() => {
    initializeWebServerConfig({
      ...validWebEnv,
      API_BASE_URL: "http://api.internal",
      MOCK_ERP_BASE_URL: "http://mock-erp.internal",
    });
  });

  afterEach(() => {
    resetWebServerConfigForTests();
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("reads only the latest run during the server-side watch bootstrap", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        summaries: [],
        page: 1,
        pageSize: 1,
        totalCount: 0,
        timestamp: "2026-06-20T00:00:10.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await WatchPage();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.internal/demo/runs/history?page=1&pageSize=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("server-loads only the exact accepted Watch result and keeps a missing result pending", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        errorPayloadSchema.parse({
          code: "resource_not_found",
          message: "Run history detail was not found.",
          correlationId: "watch-result-missing",
          timestamp: "2026-06-20T00:00:10.000Z",
        }),
        404,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = renderToStaticMarkup(
      await WatchPage({ searchParams: Promise.resolve({ acceptedRunId: runId }) }),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `http://api.internal/demo/runs/history/${runId}`,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(output).toContain(`Accepted run ID: <code>${runId}</code>`);
    expect(output).toContain("The exact result is not available yet");
  });

  it("reads paginated run history through the shared API contract", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://api.internal/demo/runs/history?page=2&pageSize=5");
      return jsonResponse({
        summaries: [
          {
            runId: "55555555-5555-4555-8555-555555555555",
            presetName: "Preview 1k",
            occurredAt: "2026-06-20T00:00:00.000Z",
            overallDurationMs: 10_000,
            resultOutcome: "completed-with-order-failures",
            plannedAttempts: 10,
            startingStock: 10,
            uniqueReservations: 6,
            soldOutRejections: 4,
            confirmedOrders: 5,
            failedOrders: 1,
            convergenceDurationSeconds: null,
          },
        ],
        page: 2,
        pageSize: 5,
        totalCount: 6,
        timestamp: "2026-06-20T00:00:10.000Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const history = await getRunHistoryPage(2, 5);
    expect(history.status).toBe("available");
    if (history.status !== "available") {
      throw new Error("Expected available history.");
    }
    expect(history.data.page).toBe(2);
    expect(history.data.summaries[0]?.resultOutcome).toBe("completed-with-order-failures");
  });

  it("bootstraps the public surface without a credentialless server recovery call", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.endsWith("/health/ready")) {
          return jsonResponse({
            service: "api",
            status: "ok",
            timestamp: "2026-06-20T00:00:10.000Z",
            uptimeSeconds: 10,
            checks: [{ name: "database_reachable", status: "ok" }],
          });
        }
        return jsonResponse({});
      }),
    );

    const surface = await getPublicDemoSurface();

    expect(surface.recovery).toEqual({ status: "loading" });
    expect(surface.readiness).toMatchObject({
      status: "available",
      data: { status: "ok" },
    });
    expect(requestedUrls).toEqual([
      "http://api.internal/demo/presets/public",
      "http://api.internal/health/ready",
      "http://api.internal/demo/runtime-policy",
    ]);
  });

  it("keeps only the safe canonical selector and retry timing on unavailable public props", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/demo/presets/public")) {
          return new Response(
            JSON.stringify(
              errorPayloadSchema.parse({
                code: "backend_unavailable",
                message: "Private preset backend message.",
                details: { probe: "private-probe" },
                correlationId: "private-public-props-correlation",
                timestamp: "2026-06-20T00:00:10.000Z",
              }),
            ),
            {
              status: 503,
              headers: { "content-type": "application/json", "retry-after": "3" },
            },
          );
        }
        if (url.endsWith("/health/ready")) return jsonResponse(readinessFixture());
        return jsonResponse({});
      }),
    );

    const surface = await getPublicDemoSurface();

    expect(surface.presets).toEqual({
      status: "unavailable",
      errorCode: "backend_unavailable",
      retryAfterMs: 3_000,
    });
    expect(JSON.stringify(surface.presets)).not.toContain("Private preset backend message.");
    expect(JSON.stringify(surface.presets)).not.toContain("private-probe");
    expect(JSON.stringify(surface.presets)).not.toContain("private-public-props-correlation");
    expect(JSON.stringify(surface.presets)).not.toContain("503");
  });

  it("retains contract-valid unavailable readiness details returned with HTTP 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/health/ready")) {
          return jsonResponse(
            {
              service: "api",
              status: "unavailable",
              timestamp: "2026-06-20T00:00:10.000Z",
              uptimeSeconds: 10,
              checks: [
                {
                  name: "database_reachable",
                  status: "unavailable",
                  message: "PostgreSQL readiness check failed.",
                },
              ],
            },
            503,
          );
        }
        return jsonResponse({});
      }),
    );

    const surface = await getPublicDemoSurface();

    expect(surface.readiness).toMatchObject({
      status: "available",
      data: { status: "unavailable", checks: [] },
    });
    expect(JSON.stringify(surface.readiness)).not.toContain("database_reachable");
    expect(JSON.stringify(surface.readiness)).not.toContain("PostgreSQL readiness check failed.");
    expect(JSON.stringify(surface.readiness)).not.toContain("503");
  });

  it("reads run history detail through the shared API contract", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(`http://api.internal/demo/runs/history/${runId}`);
      return jsonResponse(runHistoryDetailFixture());
    });
    vi.stubGlobal("fetch", fetchMock);

    const detail = await getRunHistoryDetail(runId);

    expect(detail.status).toBe("available");
    if (detail.status !== "available") {
      throw new Error("Expected available detail.");
    }
    expect(detail.data.summary.runId).toBe(runId);
    expect(detail.data.result.outcome).toBe("outcome-indeterminate");
  });

  it("proxies an exact public history detail path through its public schema", async () => {
    const runId = "55555555-5555-4555-8555-555555555555";
    const fetchMock = vi.fn(async () => jsonResponse(runHistoryDetailFixture()));
    vi.stubGlobal("fetch", fetchMock);

    const response = await getPublicRunHistoryDetail(
      new Request(`http://dashboard.local/api/demo/runs/history/${runId}`),
      { params: Promise.resolve({ runId }) },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://api.internal/demo/runs/history/${runId}`,
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    expect((await response.json()).summary.runId).toBe(runId);
  });

  it("rejects an invalid public history detail parameter before forwarding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await getPublicRunHistoryDetail(
      new Request("http://dashboard.local/api/demo/runs/history/not-a-uuid"),
      { params: Promise.resolve({ runId: "not-a-uuid" }) },
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("invalid_request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an upstream success outside the public detail schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ privateOrders: [] })),
    );

    const response = await getPublicRunHistoryDetail(
      new Request(
        "http://dashboard.local/api/demo/runs/history/55555555-5555-4555-8555-555555555555",
      ),
      {
        params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
      },
    );

    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("invalid_backend_response");
  });

  it.each([
    [404, "resource_not_found"],
    [503, "backend_unavailable"],
  ] as const)("preserves a canonical upstream %s result read failure", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          errorPayloadSchema.parse({
            code,
            message: "Exact result read failed.",
            correlationId: `result-${status}`,
            timestamp: "2026-06-20T00:00:10.000Z",
          }),
          status,
        ),
      ),
    );

    const response = await getPublicRunHistoryDetail(
      new Request(
        "http://dashboard.local/api/demo/runs/history/55555555-5555-4555-8555-555555555555",
      ),
      {
        params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
      },
    );

    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readinessFixture() {
  return {
    service: "api",
    status: "ok",
    timestamp: "2026-06-20T00:00:10.000Z",
    uptimeSeconds: 10,
    checks: [],
  };
}

function runHistoryDetailFixture() {
  const admin = {
    summary: {
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
        requestArrivalSummary: emptyRequestArrivalSummary,
        trafficDeliveryStatus: "complete",
        notes: [],
      },
      serverReservationTimingSummary: emptyServerReservationTimingSummary,
      fastReservationTargetEvaluation: evaluateFastReservationTarget(
        emptyServerReservationTimingSummary,
        10,
      ),
      businessOutcomeSummary: {
        acceptedReservations: 6,
        reservedUnits: 6,
        soldOutRejections: 4,
        queuedOrders: 0,
        processingOrders: 0,
        retryingOrders: 0,
        confirmedOrders: 5,
        failedOrders: 1,
        pendingPersistenceCount: 0,
        notificationsRecorded: 5,
      },
      replayPossible: false,
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
      runSignalTimelineSummary: null,
      capturedAt: "2026-06-20T00:00:10.000Z",
    },
    run: {
      runId: "55555555-5555-4555-8555-555555555555",
      presetId: "33333333-3333-4333-8333-333333333333",
      presetName: "Preview 1k",
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
    erpAttempts: { totalCount: 0, limit: 20, truncated: false, records: [] },
    notifications: { totalCount: 0, limit: 20, truncated: false, records: [] },
    eventTimeline: { totalCount: 0, limit: 20, truncated: false, records: [] },
    runSignalTimelineSummary: null,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
  const { id: _id, terminalInventorySnapshot, ...summary } = admin.summary;
  const { presetId: _presetId, saleOfferId: _saleOfferId, ...run } = admin.run;
  const sanitizedInventory = terminalInventorySnapshot
    ? (({ saleOfferId: _inventorySaleOfferId, source: _inventorySource, ...inventory }) =>
        inventory)(terminalInventorySnapshot)
    : undefined;
  const { notes: _deliveryNotes, ...publicDeliverySummary } = summary.trafficDeliverySummary;
  return {
    summary: {
      ...summary,
      trafficDeliverySummary: publicDeliverySummary,
      ...(sanitizedInventory ? { terminalInventorySnapshot: sanitizedInventory } : {}),
    },
    run,
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    result: deriveRunResult({
      runStatus: "completed",
      failureCategory: null,
      startingStock: 10,
      remainingStock: 0,
      durable: {
        reservedUnits: 6,
        uniqueReservations: 6,
        soldOutDecisions: 4,
        confirmedOrders: 5,
        failedOrders: 1,
        queuedOrders: 0,
        processingOrders: 0,
        durablePendingPersistenceRecords: 0,
        notificationsRecorded: 5,
      },
      heldReservationsAwaitingPersistence: 0,
      replayPossible: false,
      generator: {
        transportAttemptCounts: summary.transportAttemptCounts,
        httpSummary: summary.httpSummary,
      },
    }),
    overallDurationMs: 10_000,
    plannedAttempts: 10,
    erpAttempts: {
      totalCount: 0,
      byStatus: { succeeded: 0, failed: 0, timedOut: 0 },
      averageLatencyMs: null,
      p95LatencyMs: null,
    },
    runSignalTimelineSummary: null,
    timestamp: admin.timestamp,
  };
}
