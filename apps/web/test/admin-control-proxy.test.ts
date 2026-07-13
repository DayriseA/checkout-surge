import {
  adminDemoResetPath,
  adminMaintenanceCleanupRunsPath,
  adminPresetCopyToCustomPath,
  adminPresetDuplicatePath,
  adminPresetListPath,
  adminPresetSavePath,
  adminPublicRuntimePolicyPath,
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
import { POST as startAdminDemoRun } from "../src/app/api/admin/demo/runs/start/route.js";
import {
  GET as getAdminRuntimePolicy,
  PUT as updateAdminRuntimePolicy,
} from "../src/app/api/admin/demo/runtime-policy/route.js";
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
    process.env.PUBLIC_CLIENT_COOKIE_SECRET = "public-cookie-secret";
    const forwardedCredentials: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe("http://api.internal/dashboard/recovery");
        const credential = (init?.headers as Record<string, string>)[publicVisitorIdHeaderName];
        expect(credential).not.toBe("caller-assertion");
        expect(credential).toMatch(/^[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/);
        forwardedCredentials.push(credential);
        return jsonResponse(dashboardRecoveryPayload());
      }),
    );

    const firstResponse = await getDashboardRecovery(
      new Request("http://dashboard.local/api/dashboard/recovery", {
        headers: { [publicVisitorIdHeaderName]: "caller-assertion" },
      }),
    );
    const visitorCookie = firstResponse.headers.get("set-cookie")?.split(";")[0];
    const repeatedResponse = await getDashboardRecovery(
      new Request("http://dashboard.local/api/dashboard/recovery", {
        headers: {
          ...(visitorCookie ? { cookie: visitorCookie } : {}),
          [publicVisitorIdHeaderName]: "caller-assertion",
        },
      }),
    );
    const freshResponse = await getDashboardRecovery(
      new Request("http://dashboard.local/api/dashboard/recovery"),
    );
    const payload = await firstResponse.json();

    expect(firstResponse.status).toBe(200);
    expect(repeatedResponse.status).toBe(200);
    expect(freshResponse.status).toBe(200);
    expect(payload.currentRun).toBeNull();
    expect(forwardedCredentials[1]).toBe(forwardedCredentials[0]);
    expect(forwardedCredentials[2]).not.toBe(forwardedCredentials[0]);
  });

  it("proxies public demo run starts through the API lifecycle", async () => {
    process.env.API_BASE_URL = "http://api.internal";
    process.env.PUBLIC_CLIENT_COOKIE_SECRET = "public-cookie-secret";
    process.env.CONTROL_SERVICE_TOKEN = "public-control-token";
    const forwardedVisitorIds: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`http://api.internal${startDemoRunPath}`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        presetSlug: "preview-1k",
        correlationId: "corr-web-start",
      });
      const headers = init?.headers as Record<string, string>;
      const visitorId = headers[publicVisitorIdHeaderName];
      expect(headers[demoRunOperatorModeHeaderName]).toBe("public");
      expect(headers[controlServiceTokenHeaderName]).toBe("public-control-token");
      expect(visitorId).toMatch(/^[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/);
      forwardedVisitorIds.push(String(visitorId));
      return jsonResponse(startDemoRunPayload(), 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstResponse = await startDemoRun(
      new Request("http://dashboard.local/api/demo/runs/start", {
        method: "POST",
        body: JSON.stringify({ presetSlug: "preview-1k", correlationId: "corr-web-start" }),
      }),
    );
    const firstPayload = await firstResponse.json();
    const setCookie = firstResponse.headers.get("set-cookie");
    const secondResponse = await startDemoRun(
      new Request("http://dashboard.local/api/demo/runs/start", {
        method: "POST",
        headers: setCookie ? { cookie: setCookie.split(";")[0] ?? "" } : {},
        body: JSON.stringify({ presetSlug: "preview-1k", correlationId: "corr-web-start" }),
      }),
    );
    const secondPayload = await secondResponse.json();

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(firstPayload.run.presetName).toBe("Preview 1k");
    expect(firstPayload.correlationId).toBe("corr-web-start");
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
    process.env.CONTROL_SERVICE_TOKEN = "public-control-token";
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers[publicVisitorIdHeaderName]).toMatch(/^[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/);
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

  it.each([
    ["missing signing secret", undefined, "public-control-token"],
    ["weak signing secret", "weak", "public-control-token"],
    ["missing control token", "public-cookie-secret", undefined],
  ])("fails closed without fetch for %s", async (_case, cookieSecret, controlToken) => {
    process.env.PUBLIC_CLIENT_COOKIE_SECRET = cookieSecret;
    process.env.CONTROL_SERVICE_TOKEN = controlToken;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await startDemoRun(
      new Request("http://dashboard.local/api/demo/runs/start", {
        method: "POST",
        body: JSON.stringify({ presetSlug: "preview-1k" }),
      }),
    );
    expect(response.status).toBe(503);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain(cookieSecret ?? "public-cookie-secret");
    expect(serialized).not.toContain(controlToken ?? "public-control-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies public custom submissions as run-scoped public starts", async () => {
    process.env.API_BASE_URL = "http://api.internal";
    process.env.PUBLIC_CLIENT_COOKIE_SECRET = "public-cookie-secret";
    process.env.CONTROL_SERVICE_TOKEN = "public-control-token";
    const configOverride = {
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 321,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 3,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 44,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers[demoRunOperatorModeHeaderName]).toBe("public");
      expect(headers[publicVisitorIdHeaderName]).toMatch(/^[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/);
      expect(JSON.parse(String(init?.body))).toEqual({
        presetSlug: "public-custom",
        configOverride,
      });
      return jsonResponse(startDemoRunPayload(), 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await startDemoRun(
      new Request("http://dashboard.local/api/demo/runs/start", {
        method: "POST",
        body: JSON.stringify({ presetSlug: "public-custom", configOverride }),
      }),
    );

    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("requires an admin session before forwarding ERP chaos updates", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.ADMIN_SESSION_SECRET = "admin-session-secret";
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
    expect(payload.code).toBe("admin_session_required");
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

  it("rejects raw passphrase headers on protected admin proxy routes without a session", async () => {
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.ADMIN_SESSION_SECRET = "admin-session-secret";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    process.env.MOCK_ERP_BASE_URL = "http://mock-erp.internal";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const rawPassphraseHeaders = {
      [adminPassphraseHeaderName]: "admin-pass",
    };
    const rawPassphraseJsonHeaders = {
      "content-type": "application/json",
      ...rawPassphraseHeaders,
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

    const responses = await Promise.all([
      resetDemo(
        new Request("http://dashboard.local/api/admin/demo/reset", {
          method: "POST",
          headers: rawPassphraseHeaders,
        }),
      ),
      updateErpChaos(
        new Request("http://dashboard.local/api/admin/erp-chaos", {
          method: "PUT",
          headers: rawPassphraseJsonHeaders,
          body: JSON.stringify(erpChaosConfigPayload()),
        }),
      ),
      saveAdminPreset(
        new Request("http://dashboard.local/api/admin/demo/presets/save", {
          method: "POST",
          headers: rawPassphraseJsonHeaders,
          body: JSON.stringify(savePayload),
        }),
      ),
      deleteRunHistory(
        new Request("http://dashboard.local/api/admin/demo/runs/history", {
          method: "DELETE",
          headers: rawPassphraseJsonHeaders,
          body: JSON.stringify({ deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES" }),
        }),
      ),
      startAdminDemoRun(
        new Request("http://dashboard.local/api/admin/demo/runs/start", {
          method: "POST",
          headers: rawPassphraseJsonHeaders,
          body: JSON.stringify({ presetSlug: "preview-1k" }),
        }),
      ),
    ]);
    const payloads = (await Promise.all(responses.map((response) => response.json()))) as Array<{
      code?: string;
    }>;

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect(payloads.map((payload) => payload.code)).toEqual([
      "admin_session_required",
      "admin_session_required",
      "admin_session_required",
      "admin_session_required",
      "admin_session_required",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a valid admin session cookie for protected proxy routes", async () => {
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const headers = await adminSessionHeaders();
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
        headers,
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards valid ERP chaos updates with the server-side control token", async () => {
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.MOCK_ERP_BASE_URL = "http://mock-erp.internal";
    const headers = await adminSessionHeaders({ "content-type": "application/json" });
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
        headers,
        body: JSON.stringify(erpChaosConfigPayload()),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://mock-erp.internal/chaos");
    expect(payload.forcedOutage).toBe(true);
  });

  it("forwards ERP chaos reset with the server-side control token", async () => {
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.MOCK_ERP_BASE_URL = "http://mock-erp.internal";
    const headers = await adminSessionHeaders();
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
        headers,
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://mock-erp.internal/chaos/reset");
    expect(payload.forcedOutage).toBe(false);
  });

  it("forwards demo reset with the server-side control token", async () => {
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const headers = await adminSessionHeaders();
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
        headers,
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://api.internal${adminDemoResetPath}`);
    expect(payload.cleanedQueueCount).toBe(2);
  });

  it("forwards admin demo starts with trusted admin authority", async () => {
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const configOverride = configSnapshotPayload();
    const headers = await adminSessionHeaders({ "content-type": "application/json" });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(init?.method).toBe("POST");
      expect(headers[controlServiceTokenHeaderName]).toBe("control-token");
      expect(headers[demoRunOperatorModeHeaderName]).toBe("admin");
      expect(headers[publicVisitorIdHeaderName]).toBeUndefined();
      expect(JSON.parse(String(init?.body))).toEqual({
        presetSlug: "preview-1k",
        configOverride,
      });
      return jsonResponse(startDemoRunPayload("admin"), 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    const unauthorized = await startAdminDemoRun(
      new Request("http://dashboard.local/api/admin/demo/runs/start", {
        method: "POST",
        body: JSON.stringify({ presetSlug: "preview-1k", configOverride }),
      }),
    );
    const authorized = await startAdminDemoRun(
      new Request("http://dashboard.local/api/admin/demo/runs/start", {
        method: "POST",
        headers,
        body: JSON.stringify({ presetSlug: "preview-1k", configOverride }),
      }),
    );
    const payload = await authorized.json();

    expect(unauthorized.status).toBe(401);
    expect(authorized.status).toBe(202);
    expect(payload.run.operatorMode).toBe("admin");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://api.internal${startDemoRunPath}`);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards generated-run cleanup with validated options", async () => {
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const headers = await adminSessionHeaders({ "content-type": "application/json" });
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
        headers,
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
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const headers = await adminSessionHeaders({ "content-type": "application/json" });
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
        headers,
        body: JSON.stringify({ deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://api.internal${runHistoryPath}`);
    expect(payload.deletedSummaryCount).toBe(3);
  });

  it("forwards admin runtime policy reads and updates with the server-side control token", async () => {
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.API_BASE_URL = "http://api.internal";
    const policy = publicRuntimePolicyMutablePayload();
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );

      if (init?.method === "GET") {
        return jsonResponse(adminRuntimePolicyPayload({ policy: publicRuntimePolicyPayload() }));
      }

      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        policy,
        correlationId: "corr-policy-proxy",
      });
      return jsonResponse(
        adminRuntimePolicyPayload({
          policy: {
            ...policy,
            deploymentHardCaps: publicRuntimePolicyPayload().deploymentHardCaps,
          },
          correlationId: "corr-policy-proxy",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const headers = await adminSessionHeaders({ "content-type": "application/json" });

    const unauthorized = await getAdminRuntimePolicy(
      new Request("http://dashboard.local/api/admin/demo/runtime-policy"),
    );
    const readResponse = await getAdminRuntimePolicy(
      new Request("http://dashboard.local/api/admin/demo/runtime-policy", { headers }),
    );
    const updateResponse = await updateAdminRuntimePolicy(
      new Request("http://dashboard.local/api/admin/demo/runtime-policy", {
        method: "PUT",
        headers,
        body: JSON.stringify({ policy, correlationId: "corr-policy-proxy" }),
      }),
    );
    const payload = await updateResponse.json();

    expect(unauthorized.status).toBe(401);
    expect(readResponse.status).toBe(200);
    expect(updateResponse.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://api.internal${adminPublicRuntimePolicyPath}`,
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `http://api.internal${adminPublicRuntimePolicyPath}`,
    );
    expect(payload.correlationId).toBe("corr-policy-proxy");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forwards admin preset management with validated bodies", async () => {
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
    const headers = await adminSessionHeaders({ "content-type": "application/json" });
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

function startDemoRunPayload(operatorMode: "public" | "admin" = "public") {
  return {
    run: {
      runId: "55555555-5555-4555-8555-555555555555",
      presetId: "33333333-3333-4333-8333-333333333331",
      presetName: "Preview 1k",
      operatorMode,
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
          retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
          drainTimeoutSeconds: 300,
          pendingPersistenceRetryAfterSeconds: 30,
          circuitBreakerFailureThreshold: 5,
          circuitBreakerResetTimeoutMs: 10_000,
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
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}

function publicRuntimePolicyPayload() {
  return {
    isPublicRunBudgetEnforced: true,
    publicRunBudget: {
      windowSeconds: 300,
      perVisitorMaxStarts: 2,
      globalMaxStarts: 6,
    },
    publicCustomDefaults: configSnapshotPayload(),
    publicCustomLimits: {
      maxTotalRequests: 10_000,
      maxBuyers: 10_000,
      maxRequestsPerSecond: 1000,
      maxTrafficDurationSeconds: 120,
      maxTrafficStartDelaySeconds: 10,
      maxPreAllocatedVus: 1000,
      maxVus: 1000,
      maxStartingStock: 1000,
      maxErpLatencyMs: 2000,
      minErpMaxTps: 1,
      maxErpMaxTps: 300,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike" as const, "steady-arrival-rate" as const],
    },
    deploymentHardCaps: {
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    },
  };
}

function publicRuntimePolicyMutablePayload() {
  const policy = publicRuntimePolicyPayload();

  return {
    isPublicRunBudgetEnforced: policy.isPublicRunBudgetEnforced,
    publicRunBudget: {
      windowSeconds: 120,
      perVisitorMaxStarts: 1,
      globalMaxStarts: 3,
    },
    publicCustomDefaults: policy.publicCustomDefaults,
    publicCustomLimits: {
      ...policy.publicCustomLimits,
      maxBuyers: 500,
    },
  };
}

function adminRuntimePolicyPayload(options: {
  policy: ReturnType<typeof publicRuntimePolicyPayload>;
  correlationId?: string;
}) {
  return {
    id: "active",
    policy: options.policy,
    updatedAt: "2026-06-20T00:00:10.000Z",
    correlationId: options.correlationId ?? "corr-policy-read",
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

async function adminSessionHeaders(
  headers: Record<string, string> = {},
): Promise<Record<string, string>> {
  return {
    ...headers,
    cookie: await adminSessionCookie(),
  };
}

async function adminSessionCookie(): Promise<string> {
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
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";

  expect(response.status).toBe(200);
  expect(cookie).toContain("checkout_surge_admin_session=");

  return cookie;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
