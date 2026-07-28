import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("makes no backend reads during the server-side watch bootstrap", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    WatchPage();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads paginated run history through the shared API contract", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://api.internal/demo/runs/history?page=2&pageSize=5");
      return jsonResponse({
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
    expect(history.data.summaries[0]?.trafficDeliverySummary.trafficDeliveryStatus).toBe(
      "complete",
    );
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

    expect(surface.recovery).toEqual({
      status: "unavailable",
      reason: "Authoritative run state is loading.",
    });
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
      httpStatus: 503,
      data: {
        status: "unavailable",
        checks: [
          {
            name: "database_reachable",
            status: "unavailable",
            message: "PostgreSQL readiness check failed.",
          },
        ],
      },
    });
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
    expect(detail.data.orders.byStatus.confirmed).toBe(1);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
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
    orders: { totalCount: 1, byStatus: { queued: 0, processing: 0, confirmed: 1, failed: 0 } },
    erpAttempts: {
      totalCount: 0,
      byStatus: { succeeded: 0, failed: 0, timedOut: 0 },
      averageLatencyMs: null,
      p95LatencyMs: null,
    },
    notifications: { totalCount: 0 },
    events: { totalCount: 0 },
    timestamp: admin.timestamp,
  };
}
