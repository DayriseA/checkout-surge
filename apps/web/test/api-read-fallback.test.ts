import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDashboardBackendSnapshot,
  getRunHistoryDetail,
  getRunHistoryPage,
} from "../src/app/lib/api.js";
import {
  initializeWebServerConfig,
  resetWebServerConfigForTests,
} from "../src/app/lib/server/config.js";

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

  it("returns unavailable snapshots when backend reads fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("backend offline");
      }),
    );

    const snapshot = await getDashboardBackendSnapshot();

    expect(snapshot.liveness).toMatchObject({
      status: "unavailable",
      reason: "backend offline",
    });
    expect(snapshot.readiness).toMatchObject({
      status: "unavailable",
      reason: "backend offline",
    });
    expect(snapshot.recovery).toMatchObject({
      status: "unavailable",
      reason: "backend offline",
    });
    expect(snapshot.erpChaos).toMatchObject({
      status: "unavailable",
      reason: "backend offline",
    });
  });

  it("returns the expanded dashboard recovery projection when backend reads succeed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);

        if (url.endsWith("/health/live")) {
          return jsonResponse({
            service: "api",
            status: "ok",
            timestamp: "2026-06-20T00:00:10.000Z",
            uptimeSeconds: 10,
          });
        }

        if (url.endsWith("/health/ready")) {
          return jsonResponse({
            service: "api",
            status: "ok",
            timestamp: "2026-06-20T00:00:10.000Z",
            uptimeSeconds: 10,
            checks: [{ name: "database_reachable", status: "ok" }],
          });
        }

        if (url.endsWith("/chaos")) {
          return jsonResponse({
            latencyMs: 125,
            maxTps: 50,
            errorRate: 0.1,
            forcedOutage: false,
            updatedAt: "2026-06-20T00:00:10.000Z",
          });
        }

        return jsonResponse({
          currentRun: null,
          inventory: null,
          recentMetrics: [],
          queue: null,
          erp: null,
          businessOutcome: {
            acceptedReservations: 3,
            soldOutRejections: 2,
            queuedOrders: 1,
            processingOrders: 0,
            retryingOrders: 0,
            confirmedOrders: 1,
            failedOrders: 0,
            pendingPersistenceCount: 0,
            notificationsRecorded: 0,
          },
          consistencyLag: {
            confirmedOrderCount: 1,
            pendingConfirmationCount: 1,
            averageLagMs: 225,
            p95LagMs: 225,
            maxLagMs: 225,
            oldestPendingAgeSeconds: 8.5,
            measuredAt: "2026-06-20T00:00:10.000Z",
          },
          recoveredAt: "2026-06-20T00:00:10.000Z",
        });
      }),
    );

    const snapshot = await getDashboardBackendSnapshot();

    expect(snapshot.recovery).toMatchObject({
      status: "available",
      data: {
        businessOutcome: {
          acceptedReservations: 3,
          confirmedOrders: 1,
        },
        consistencyLag: {
          p95LagMs: 225,
          pendingConfirmationCount: 1,
        },
      },
    });
    expect(snapshot.erpChaos).toMatchObject({
      status: "available",
      data: {
        latencyMs: 125,
        maxTps: 50,
        errorRate: 0.1,
      },
    });
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
    expect(detail.data.orders.records[0]?.publicOrderId).toBe("ord_history_1");
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function runHistoryDetailFixture() {
  return {
    summary: {
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
}
