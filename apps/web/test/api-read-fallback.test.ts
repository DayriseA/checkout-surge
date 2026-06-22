import { afterEach, describe, expect, it, vi } from "vitest";
import { getDashboardBackendSnapshot } from "../src/app/lib/api.js";

describe("dashboard backend API reads", () => {
  afterEach(() => {
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
      },
    });
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
