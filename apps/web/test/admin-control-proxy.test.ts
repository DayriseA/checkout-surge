import {
  adminDemoResetPath,
  adminMaintenanceCleanupRunsPath,
  adminPresetCopyToCustomPath,
  adminPresetDuplicatePath,
  adminPresetListPath,
  adminPresetSavePath,
  controlServiceTokenHeaderName,
  demoRunOperatorModeHeaderName,
  publicVisitorIdHeaderName,
  runHistoryPath,
  startDemoRunPath,
} from "@checkout-surge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as copyPresetToCustom } from "../src/app/api/admin/demo/presets/copy-to-custom/route.js";
import { POST as duplicatePreset } from "../src/app/api/admin/demo/presets/duplicate/route.js";
import { GET as listAdminPresets } from "../src/app/api/admin/demo/presets/route.js";
import { POST as saveAdminPreset } from "../src/app/api/admin/demo/presets/save/route.js";
import { POST as resetDemo } from "../src/app/api/admin/demo/reset/route.js";
import { POST as cleanupRuns } from "../src/app/api/admin/demo/runs/cleanup/route.js";
import { DELETE as deleteRunHistory } from "../src/app/api/admin/demo/runs/history/route.js";
import { POST as resetErpChaos } from "../src/app/api/admin/erp-chaos/reset/route.js";
import { PUT as updateErpChaos } from "../src/app/api/admin/erp-chaos/route.js";
import { POST as createAdminSession } from "../src/app/api/admin/session/route.js";
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
    process.env.PUBLIC_CLIENT_COOKIE_SECRET = "public-cookie-secret";
    const forwardedVisitorIds: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`http://api.internal${startDemoRunPath}`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ presetSlug: "preview-1k" });
      const headers = init?.headers as Record<string, string>;
      const visitorId = headers[publicVisitorIdHeaderName];
      expect(headers[demoRunOperatorModeHeaderName]).toBe("public");
      expect(visitorId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      forwardedVisitorIds.push(String(visitorId));
      return jsonResponse(startDemoRunPayload(), 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstResponse = await startDemoRun(
      new Request("http://dashboard.local/api/demo/runs/start", {
        method: "POST",
        body: JSON.stringify({ presetSlug: "preview-1k" }),
      }),
    );
    const firstPayload = await firstResponse.json();
    const setCookie = firstResponse.headers.get("set-cookie");
    const secondResponse = await startDemoRun(
      new Request("http://dashboard.local/api/demo/runs/start", {
        method: "POST",
        headers: setCookie ? { cookie: setCookie.split(";")[0] ?? "" } : {},
        body: JSON.stringify({ presetSlug: "preview-1k" }),
      }),
    );
    const secondPayload = await secondResponse.json();

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(firstPayload.run.presetName).toBe("Preview 1k");
    expect(secondPayload.run.presetName).toBe("Preview 1k");
    expect(setCookie).toContain("checkout_surge_public_visitor=");
    expect(setCookie).toContain("HttpOnly");
    expect(forwardedVisitorIds).toHaveLength(2);
    expect(forwardedVisitorIds[1]).toBe(forwardedVisitorIds[0]);
    expect(secondResponse.headers.get("set-cookie")).toBeNull();
  });

  it("rotates malformed public visitor cookies before proxying demo run starts", async () => {
    process.env.API_BASE_URL = "http://api.internal";
    process.env.PUBLIC_CLIENT_COOKIE_SECRET = "public-cookie-secret";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers[publicVisitorIdHeaderName]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      return jsonResponse(startDemoRunPayload(), 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await startDemoRun(
      new Request("http://dashboard.local/api/demo/runs/start", {
        method: "POST",
        headers: { cookie: "checkout_surge_public_visitor=%" },
        body: JSON.stringify({ presetSlug: "preview-1k" }),
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("set-cookie")).toContain("checkout_surge_public_visitor=");
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

  it("sets a signed HttpOnly admin session after passphrase validation", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.ADMIN_SESSION_SECRET = "admin-session-secret";

    const response = await createAdminSession(
      new Request("http://dashboard.local/api/admin/session", {
        method: "POST",
        headers: {
          [adminPassphraseHeaderName]: "admin-pass",
        },
      }),
    );
    const payload = await response.json();
    const setCookie = response.headers.get("set-cookie");

    expect(response.status).toBe(200);
    expect(payload.authenticated).toBe(true);
    expect(setCookie).toContain("checkout_surge_admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("accepts a valid admin session cookie for protected proxy routes", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.ADMIN_SESSION_SECRET = "admin-session-secret";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const session = await createAdminSession(
      new Request("http://dashboard.local/api/admin/session", {
        method: "POST",
        headers: {
          [adminPassphraseHeaderName]: "admin-pass",
        },
      }),
    );
    const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        failedRunCount: 1,
        closedSaleOfferCount: 1,
        cleanedQueueCount: 2,
        cleanedJobCount: 3,
        resetAt: "2026-06-20T00:00:10.000Z",
        correlationId: "corr-reset",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await resetDemo(
      new Request("http://dashboard.local/api/admin/demo/reset", {
        method: "POST",
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("forwards demo reset with the server-side control token", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );
      return jsonResponse({
        failedRunCount: 1,
        closedSaleOfferCount: 1,
        cleanedQueueCount: 2,
        cleanedJobCount: 3,
        resetAt: "2026-06-20T00:00:10.000Z",
        correlationId: "corr-reset",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await resetDemo(
      new Request("http://dashboard.local/api/admin/demo/reset", {
        method: "POST",
        headers: {
          [adminPassphraseHeaderName]: "admin-pass",
        },
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://api.internal${adminDemoResetPath}`);
    expect(payload.cleanedQueueCount).toBe(2);
  });

  it("forwards generated-run cleanup with validated options", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );
      expect(JSON.parse(String(init?.body))).toEqual({ keepLatest: 15, olderThanDays: 7 });
      return jsonResponse({
        deletedRunCount: 2,
        deletedSaleOfferCount: 2,
        preservedLatestCount: 15,
        preservedActiveRunCount: 0,
        cutoffBefore: "2026-06-13T00:00:10.000Z",
        cleanedAt: "2026-06-20T00:00:10.000Z",
        correlationId: "corr-cleanup",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await cleanupRuns(
      new Request("http://dashboard.local/api/admin/demo/runs/cleanup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [adminPassphraseHeaderName]: "admin-pass",
        },
        body: JSON.stringify({ keepLatest: 15, olderThanDays: 7 }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://api.internal${adminMaintenanceCleanupRunsPath}`,
    );
    expect(payload.deletedRunCount).toBe(2);
  });

  it("forwards run history deletion with the server-side control token", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES",
      });
      return jsonResponse({
        deletedSummaryCount: 3,
        deletedAt: "2026-06-20T00:00:10.000Z",
        correlationId: "corr-delete-history",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await deleteRunHistory(
      new Request("http://dashboard.local/api/admin/demo/runs/history", {
        method: "DELETE",
        headers: {
          [adminPassphraseHeaderName]: "admin-pass",
        },
        body: JSON.stringify({ deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://api.internal${runHistoryPath}`);
    expect(payload.deletedSummaryCount).toBe(3);
  });

  it("forwards admin preset management with validated bodies", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );

      if (String(input).endsWith(adminPresetListPath)) {
        expect(init?.method).toBe("GET");
        return jsonResponse({
          presets: [demoPresetPayload("custom")],
          timestamp: "2026-06-20T00:00:10.000Z",
        });
      }

      expect(init?.method).toBe("POST");
      return jsonResponse({
        preset: demoPresetPayload("custom"),
        timestamp: "2026-06-20T00:00:10.000Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const headers = {
      "content-type": "application/json",
      [adminPassphraseHeaderName]: "admin-pass",
    };
    const savePayload = {
      slug: "custom",
      display: {
        name: "Custom",
        description: "Updated custom preset.",
        sortOrder: 120,
        outcomeFocus: [],
      },
      ...configSnapshotPayload(),
    };

    const listResponse = await listAdminPresets(
      new Request("http://dashboard.local/api/admin/demo/presets", { headers }),
    );
    const saveResponse = await saveAdminPreset(
      new Request("http://dashboard.local/api/admin/demo/presets/save", {
        method: "POST",
        headers,
        body: JSON.stringify(savePayload),
      }),
    );
    const duplicateResponse = await duplicatePreset(
      new Request("http://dashboard.local/api/admin/demo/presets/duplicate", {
        method: "POST",
        headers,
        body: JSON.stringify({ sourceSlug: "preview-1k", targetSlug: "preview-copy" }),
      }),
    );
    const copyResponse = await copyPresetToCustom(
      new Request("http://dashboard.local/api/admin/demo/presets/copy-to-custom", {
        method: "POST",
        headers,
        body: JSON.stringify({ sourceSlug: "preview-1k" }),
      }),
    );
    const invalidDuplicate = await duplicatePreset(
      new Request("http://dashboard.local/api/admin/demo/presets/duplicate", {
        method: "POST",
        headers,
        body: JSON.stringify({ sourceSlug: "" }),
      }),
    );

    expect(listResponse.status).toBe(200);
    expect(saveResponse.status).toBe(200);
    expect(duplicateResponse.status).toBe(200);
    expect(copyResponse.status).toBe(200);
    expect(invalidDuplicate.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://api.internal${adminPresetListPath}`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(`http://api.internal${adminPresetSavePath}`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(savePayload);
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe(
      `http://api.internal${adminPresetDuplicatePath}`,
    );
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe(
      `http://api.internal${adminPresetCopyToCustomPath}`,
    );
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

function demoPresetPayload(slug: string) {
  return {
    id:
      slug === "custom"
        ? "44444444-4444-4444-8444-444444444443"
        : "33333333-3333-4333-8333-333333333331",
    slug,
    visibility: slug === "custom" ? "admin" : "public",
    isEditable: slug === "custom",
    isCustom: slug === "custom",
    display: {
      name: slug === "custom" ? "Custom" : "Preview 1k",
      description: "Preset fixture.",
      sortOrder: 120,
      outcomeFocus: [],
    },
    ...configSnapshotPayload(),
    createdAt: "2026-06-20T00:00:10.000Z",
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function configSnapshotPayload() {
  return {
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
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
