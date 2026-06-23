import { controlServiceTokenHeaderName, startDemoRunPath } from "@checkout-surge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as resetErpChaos } from "../src/app/api/admin/erp-chaos/reset/route.js";
import { PUT as updateErpChaos } from "../src/app/api/admin/erp-chaos/route.js";
import { GET as getDashboardRecovery } from "../src/app/api/dashboard/recovery/route.js";
import { POST as startDemoRun } from "../src/app/api/demo/runs/start/route.js";
import { adminPassphraseHeaderName } from "../src/app/lib/control-paths.js";

const originalEnv = { ...process.env };

describe("dashboard control proxy routes", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("proxies dashboard recovery through the API boundary", async () => {
    process.env.API_BASE_URL = "http://api.internal";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toBe("http://api.internal/dashboard/recovery");
        return jsonResponse(dashboardRecoveryPayload());
      }),
    );

    const response = await getDashboardRecovery();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.currentRun).toBeNull();
  });

  it("proxies public demo run starts through the API lifecycle", async () => {
    process.env.API_BASE_URL = "http://api.internal";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`http://api.internal${startDemoRunPath}`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        presetSlug: "preview-1k",
        operatorMode: "public",
        publicVisitorId: "visitor-1",
      });
      return jsonResponse(startDemoRunPayload(), 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await startDemoRun(
      new Request("http://dashboard.local/api/demo/runs/start", {
        method: "POST",
        body: JSON.stringify({
          presetSlug: "preview-1k",
          operatorMode: "public",
          publicVisitorId: "visitor-1",
        }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.run.presetName).toBe("Preview 1k");
  });

  it("requires the admin passphrase before forwarding ERP chaos updates", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await updateErpChaos(
      new Request("http://dashboard.local/api/admin/erp-chaos", {
        method: "PUT",
        body: JSON.stringify(erpChaosConfigPayload()),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(401);
    expect(payload.code).toBe("admin_passphrase_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards valid ERP chaos updates with the server-side control token", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.MOCK_ERP_BASE_URL = "http://mock-erp.internal";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        latencyMs: 250,
        maxTps: 20,
        errorRate: 0.25,
        forcedOutage: true,
      });
      return jsonResponse(erpChaosStatusPayload());
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await updateErpChaos(
      new Request("http://dashboard.local/api/admin/erp-chaos", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          [adminPassphraseHeaderName]: "admin-pass",
        },
        body: JSON.stringify(erpChaosConfigPayload()),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://mock-erp.internal/chaos");
    expect(payload.forcedOutage).toBe(true);
  });

  it("forwards ERP chaos reset with the server-side control token", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.MOCK_ERP_BASE_URL = "http://mock-erp.internal";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );
      return jsonResponse({ ...erpChaosStatusPayload(), forcedOutage: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await resetErpChaos(
      new Request("http://dashboard.local/api/admin/erp-chaos/reset", {
        method: "POST",
        headers: {
          [adminPassphraseHeaderName]: "admin-pass",
        },
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://mock-erp.internal/chaos/reset");
    expect(payload.forcedOutage).toBe(false);
  });
});

function erpChaosConfigPayload() {
  return {
    latencyMs: 250,
    maxTps: 20,
    errorRate: 0.25,
    forcedOutage: true,
  };
}

function erpChaosStatusPayload() {
  return {
    ...erpChaosConfigPayload(),
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function dashboardRecoveryPayload() {
  return {
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    recoveredAt: "2026-06-20T00:00:10.000Z",
  };
}

function startDemoRunPayload() {
  return {
    run: {
      runId: "55555555-5555-4555-8555-555555555555",
      presetId: "33333333-3333-4333-8333-333333333331",
      presetName: "Preview 1k",
      operatorMode: "public",
      status: "active",
      trafficStatus: "active",
      saleOfferId: "22222222-2222-4222-8222-222222222222",
      configSnapshot: {
        trafficConfig: {
          mode: "buyer-spike",
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
          queueName: "orders:process",
          physicalQueueName: "orders-process",
          orderProcessConcurrency: 5,
          drainTimeoutSeconds: 300,
          pendingPersistenceRetryAfterSeconds: 30,
        },
      },
      startedAt: "2026-06-20T00:00:10.000Z",
      trafficStartedAt: "2026-06-20T00:00:10.000Z",
    },
    recovery: { establishedAt: "2026-06-20T00:00:10.000Z" },
    correlationId: "corr-web-start",
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
