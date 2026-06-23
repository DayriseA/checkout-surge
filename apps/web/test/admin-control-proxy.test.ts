import { controlServiceTokenHeaderName } from "@checkout-surge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as resetErpChaos } from "../src/app/api/admin/erp-chaos/reset/route.js";
import { PUT as updateErpChaos } from "../src/app/api/admin/erp-chaos/route.js";
import { GET as getDashboardRecovery } from "../src/app/api/dashboard/recovery/route.js";
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

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
