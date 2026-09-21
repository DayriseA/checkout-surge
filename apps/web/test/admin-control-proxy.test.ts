import {
  adminDemoResetPath,
  adminMaintenanceCleanupRunsPath,
  adminPresetCopyToCustomPath,
  adminPresetDuplicatePath,
  adminPresetListPath,
  adminPresetSavePath,
  adminPublicRuntimePolicyPath,
  controlServiceTokenHeaderName,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
  demoRunOperatorModeHeaderName,
  errorPayloadSchema,
  previewDemoRunPath,
  previewDemoRunResponseSchema,
  publicVisitorIdHeaderName,
  runHistoryPath,
  startDemoRunPath,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture as configSnapshotPayload } from "@checkout-surge/contracts/testing";
import { correlationIdHeaderName } from "@checkout-surge/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as copyPresetToCustom } from "../src/app/api/admin/demo/presets/copy-to-custom/route.js";
import { POST as duplicatePreset } from "../src/app/api/admin/demo/presets/duplicate/route.js";
import {
  DELETE as archiveAdminPreset,
  GET as listAdminPresets,
} from "../src/app/api/admin/demo/presets/route.js";
import { POST as saveAdminPreset } from "../src/app/api/admin/demo/presets/save/route.js";
import { POST as resetDemo } from "../src/app/api/admin/demo/reset/route.js";
import { POST as cleanupRuns } from "../src/app/api/admin/demo/runs/cleanup/route.js";
import { POST as previewAdminDemoRun } from "../src/app/api/admin/demo/runs/estimate/route.js";
import { DELETE as deleteRunHistory } from "../src/app/api/admin/demo/runs/history/route.js";
import { POST as startAdminDemoRun } from "../src/app/api/admin/demo/runs/start/route.js";
import {
  GET as getAdminRuntimePolicy,
  PUT as updateAdminRuntimePolicy,
} from "../src/app/api/admin/demo/runtime-policy/route.js";
import { POST as resetErpChaos } from "../src/app/api/admin/erp-chaos/reset/route.js";
import { GET as getErpChaos, PUT as updateErpChaos } from "../src/app/api/admin/erp-chaos/route.js";
import { POST as createAdminSession } from "../src/app/api/admin/session/route.js";
import { GET as getDashboardRecovery } from "../src/app/api/dashboard/recovery/route.js";
import { POST as previewDemoRun } from "../src/app/api/demo/runs/estimate/route.js";
import { POST as startDemoRun } from "../src/app/api/demo/runs/start/route.js";
import { GET as getReadiness } from "../src/app/api/health/ready/route.js";
import { adminPassphraseHeaderName } from "../src/app/lib/control-paths.js";
import { resetAdminLoginAttemptLimiterForTests } from "../src/app/lib/server/admin-login-composition.js";
import { createAdminSessionToken } from "../src/app/lib/server/admin-session.js";
import { initializeWebServerConfig } from "../src/app/lib/server/config.js";
import { estimateFixture } from "./estimate-fixtures.js";

const originalEnv = { ...process.env };

describe("dashboard control proxy routes", () => {
  beforeEach(() => {
    process.env.WEB_ORIGIN = "http://dashboard.local";
    process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
    process.env.ADMIN_SESSION_SECRET = "admin-session-secret";
    process.env.CONTROL_SERVICE_TOKEN = "control-token";
    process.env.PUBLIC_CLIENT_COOKIE_SECRET = "public-cookie-secret";
    process.env.API_BASE_URL = "http://api.internal";
    process.env.MOCK_ERP_BASE_URL = "http://mock-erp.internal";
    initializeWebServerConfig(process.env);
  });

  afterEach(() => {
    resetAdminLoginAttemptLimiterForTests();
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("fails every private admin proxy route closed before body parsing or fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const expired = createAdminSessionToken({
      secret: "admin-session-secret",
      nowSeconds: Math.floor(Date.now() / 1000) - 28_801,
      maxAgeSeconds: 28_800,
    });
    const privateRoutes: Array<[string, string, (request: Request) => Promise<Response>]> = [
      ["preset list", "GET", listAdminPresets],
      ["preset archive", "DELETE", archiveAdminPreset],
      ["preset save", "POST", saveAdminPreset],
      ["preset duplicate", "POST", duplicatePreset],
      ["preset copy", "POST", copyPresetToCustom],
      ["demo reset", "POST", resetDemo],
      ["run cleanup", "POST", cleanupRuns],
      ["history delete", "DELETE", deleteRunHistory],
      ["run start", "POST", startAdminDemoRun],
      ["run estimate", "POST", previewAdminDemoRun],
      ["runtime policy read", "GET", getAdminRuntimePolicy],
      ["runtime policy update", "PUT", updateAdminRuntimePolicy],
      ["ERP update", "PUT", updateErpChaos],
      ["ERP reset", "POST", resetErpChaos],
    ];
    for (const [name, method, handler] of privateRoutes) {
      const request = (headers: Record<string, string> = {}) =>
        new Request("http://dashboard.local/api/admin/test", {
          method,
          headers: {
            ...(method === "GET" ? {} : { origin: "http://dashboard.local" }),
            ...headers,
          },
          ...(method === "GET" ? {} : { body: "not-json" }),
        });
      const missingResponse = await handler(request());
      expect(missingResponse.status, `${name}: missing`).toBe(401);
      expect((await missingResponse.json()).code, `${name}: missing code`).toBe(
        "admin_session_required",
      );
      const rawPassphraseResponse = await handler(
        request({ [adminPassphraseHeaderName]: "admin-pass" }),
      );
      expect(rawPassphraseResponse.status, `${name}: raw passphrase`).toBe(401);
      expect((await rawPassphraseResponse.json()).code, `${name}: raw passphrase code`).toBe(
        "admin_session_required",
      );
      expect(
        (await handler(request({ cookie: "checkout_surge_admin_session=tampered" }))).status,
        `${name}: tampered`,
      ).toBe(401);
      expect(
        (
          await handler(
            request({
              cookie: `checkout_surge_admin_session=${encodeURIComponent(expired)}`,
            }),
          )
        ).status,
        `${name}: expired`,
      ).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies dashboard recovery through the API boundary", async () => {
    const forwardedCredentials: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe("http://api.internal/dashboard/recovery");
        const credential = (init?.headers as Record<string, string>)[publicVisitorIdHeaderName];
        expect(credential).not.toBe("caller-assertion");
        expect(credential).toMatch(/^[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/);
        forwardedCredentials.push(String(credential));
        return jsonResponse(
          dashboardRecoveryPayload(
            (init?.headers as Record<string, string>)[correlationIdHeaderName] ?? "corr-recovery",
          ),
        );
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

  it("proxies readiness without minting or forwarding a visitor credential", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://api.internal/health/ready");
      expect(new Headers(init?.headers).has(publicVisitorIdHeaderName)).toBe(false);
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
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await getReadiness(
      new Request("http://dashboard.local/api/health/ready", {
        headers: { [publicVisitorIdHeaderName]: "caller-assertion" },
      }),
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "unavailable",
      checks: [],
    });
    expect(JSON.stringify(body)).not.toContain("database_reachable");
    expect(JSON.stringify(body)).not.toContain("PostgreSQL readiness check failed.");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("forwards only a validated complete known recovery scope", async () => {
    const knownRunId = "11111111-1111-4111-8111-111111111111";
    const knownSaleOfferId = "22222222-2222-4222-8222-222222222222";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        expect(String(input)).toBe(
          `http://api.internal/dashboard/recovery?knownRunId=${knownRunId}&knownSaleOfferId=${knownSaleOfferId}`,
        );
        return jsonResponse(dashboardRecoveryPayload("corr-known-scope"));
      }),
    );

    const response = await getDashboardRecovery(
      new Request(
        `http://dashboard.local/api/dashboard/recovery?knownRunId=${knownRunId}&knownSaleOfferId=${knownSaleOfferId}`,
      ),
    );

    expect(response.status).toBe(200);
  });

  it.each([
    ["partial", "?knownRunId=11111111-1111-4111-8111-111111111111"],
    ["malformed", "?knownRunId=not-a-uuid&knownSaleOfferId=22222222-2222-4222-8222-222222222222"],
    ["unknown", "?unexpected=value"],
  ])("rejects %s dashboard recovery query input without calling upstream", async (_case, query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await getDashboardRecovery(
      new Request(`http://dashboard.local/api/dashboard/recovery${query}`, {
        headers: { [correlationIdHeaderName]: "corr-invalid-recovery-query" },
      }),
    );

    expect(response.status).toBe(400);
    expect(errorPayloadSchema.parse(await response.json())).toMatchObject({
      code: "invalid_request",
      correlationId: "corr-invalid-recovery-query",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "public",
    "admin",
  ] as const)("validates and proxies %s estimates with server-owned headers", async (mode) => {
    const handler = mode === "admin" ? previewAdminDemoRun : previewDemoRun;
    const headers = mode === "admin" ? await adminSessionHeaders() : {};
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ result: estimateFixture("over_ceiling") }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = (body: unknown) =>
      new Request(
        `http://dashboard.local/api/${mode === "admin" ? "admin/" : ""}demo/runs/estimate`,
        {
          method: "POST",
          headers: {
            ...headers,
            [controlServiceTokenHeaderName]: "forged",
            [demoRunOperatorModeHeaderName]: "forged",
            [publicVisitorIdHeaderName]: "forged",
            [correlationIdHeaderName]: "estimate-correlation",
          },
          body: JSON.stringify(body),
        },
      );
    for (const body of [
      {},
      { presetSlug: "preview-1k", estimate: {} },
      {
        presetSlug: "preview-1k",
        configOverride: { backpressureConfig: { drainTimeoutSeconds: 20 } },
      },
    ]) {
      expect((await handler(request(body))).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    for (const kind of ["allowed", "over_ceiling", "unestimable"] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ result: estimateFixture(kind) }));
      const response = await handler(request({ presetSlug: "preview-1k" }));
      expect(response.status).toBe(200);
      expect(previewDemoRunResponseSchema.parse(await response.json()).result).toEqual(
        estimateFixture(kind),
      );
      expect(response.headers.get(correlationIdHeaderName)).toBe("estimate-correlation");
      if (mode === "public") expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    }
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`http://api.internal${previewDemoRunPath}`);
    expect(JSON.parse(String(init?.body))).toEqual({ presetSlug: "preview-1k" });
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get(controlServiceTokenHeaderName)).toBe("control-token");
    expect(forwarded.get(demoRunOperatorModeHeaderName)).toBe(mode);
    expect(forwarded.get(correlationIdHeaderName)).toBe("estimate-correlation");
    if (mode === "public")
      expect(forwarded.get(publicVisitorIdHeaderName)).toMatch(
        /^[0-9a-f-]{36}\.\d+\.[0-9a-f]{64}$/,
      );
    else expect(forwarded.get(publicVisitorIdHeaderName)).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: { decision: "admitted" } }));
    expect((await handler(request({ presetSlug: "preview-1k" }))).status).toBe(502);
  });

  it("rejects untrusted admin preview Origins before parsing or fetch", async () => {
    const cookie = await adminSessionCookie();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const origin of [undefined, "null", "not an origin", "http://evil.local"]) {
      const response = await previewAdminDemoRun(
        new Request("http://dashboard.local/api/admin/demo/runs/estimate", {
          method: "POST",
          headers: { cookie, ...(origin ? { origin } : {}) },
          body: "not-json",
        }),
      );
      expect(response.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies public demo run starts through the API lifecycle", async () => {
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
      expect(headers[controlServiceTokenHeaderName]).toBe("control-token");
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

  it("preserves the API-owned public budget Retry-After through the BFF", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              errorPayloadSchema.parse({
                code: "public_run_budget_exceeded",
                message: "Public run budget is exhausted.",
                correlationId: "corr-budget-bff",
                details: { budget: "global" },
                timestamp: "2026-06-20T00:00:10.000Z",
              }),
            ),
            {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "59" },
            },
          ),
      ),
    );

    const response = await startDemoRun(
      new Request("http://dashboard.local/api/demo/runs/start", {
        method: "POST",
        body: JSON.stringify({ presetSlug: "preview-1k" }),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("59");
    expect(errorPayloadSchema.parse(await response.json())).toMatchObject({
      code: "public_run_budget_exceeded",
      details: { budget: "global" },
    });
  });

  it("rotates malformed public visitor cookies before proxying demo run starts", async () => {
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

  it("proxies public custom submissions as run-scoped public starts", async () => {
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

  it("sets a signed HttpOnly admin session after passphrase validation", async () => {
    const response = await createAdminSession(
      new Request("http://dashboard.local/api/admin/session", {
        method: "POST",
        headers: { origin: "http://dashboard.local" },
        body: JSON.stringify({ passphrase: "admin-pass" }),
      }),
    );
    const payload = await response.json();
    const setCookie = response.headers.get("set-cookie");

    expect(response.status).toBe(200);
    expect(payload.authenticated).toBe(true);
    expect(setCookie).toContain("checkout_surge_admin_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("rejects every untrusted unsafe admin Origin before parsing or fetch", async () => {
    const cookie = await adminSessionCookie();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const origin of [undefined, "null", "not an origin", "http://evil.local"]) {
      const response = await updateErpChaos(
        new Request("http://dashboard.local/api/admin/erp-chaos", {
          method: "PUT",
          headers: {
            cookie,
            ...(origin === undefined ? {} : { origin }),
          },
          body: "not-json",
        }),
      );
      expect(response.status).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          presets: [{ ...demoPresetPayload("custom"), canArchive: false }],
          timestamp: "2026-06-20T00:00:10.000Z",
        }),
      ),
    );
    const privateGet = await listAdminPresets(
      new Request("http://dashboard.local/api/admin/demo/presets", {
        headers: { cookie },
      }),
    );
    expect(privateGet.status).toBe(200);
  });

  it("keeps the read-only ERP chaos status public", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(erpChaosStatusPayload()));
    vi.stubGlobal("fetch", fetchMock);
    const response = await getErpChaos(new Request("http://dashboard.local/api/admin/erp-chaos"));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps global ERP chaos unchanged across the API-owned demo reset", async () => {
    const headers = await adminSessionHeaders({ "content-type": "application/json" });
    const configuredChaos = erpChaosConfigPayload();
    let chaos = { latencyMs: 0, maxTps: 100, errorRate: 0, forcedOutage: false };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://mock-erp.internal/chaos" && init?.method === "PUT") {
        chaos = JSON.parse(String(init.body));
        return jsonResponse({ ...erpChaosStatusPayload(), ...chaos });
      }
      if (url === `http://api.internal${adminDemoResetPath}`) {
        return jsonResponse({
          failedRunCount: 0,
          closedSaleOfferCount: 0,
          cleanedQueueCount: 0,
          cleanedJobCount: 0,
          resetAt: "2026-06-20T00:00:10.000Z",
          correlationId: "corr-reset",
        });
      }
      if (url === "http://mock-erp.internal/chaos" && init?.method === "GET") {
        return jsonResponse({ ...erpChaosStatusPayload(), ...chaos });
      }
      if (url === "http://mock-erp.internal/chaos/reset") {
        chaos = { latencyMs: 0, maxTps: 100, errorRate: 0, forcedOutage: false };
        return jsonResponse({ ...erpChaosStatusPayload(), ...chaos });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateErpChaos(
      new Request("http://dashboard.local/api/admin/erp-chaos", {
        method: "PUT",
        headers,
        body: JSON.stringify(configuredChaos),
      }),
    );
    await resetDemo(
      new Request("http://dashboard.local/api/admin/demo/reset", {
        method: "POST",
        headers,
      }),
    );
    const status = await getErpChaos(new Request("http://dashboard.local/api/admin/erp-chaos"));

    expect(await status.json()).toMatchObject(configuredChaos);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "http://mock-erp.internal/chaos",
      `http://api.internal${adminDemoResetPath}`,
      "http://mock-erp.internal/chaos",
    ]);
  });

  it("forwards valid ERP chaos updates with the server-side control token", async () => {
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
        headers: { origin: "http://dashboard.local" },
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
    const headers = await adminSessionHeaders({ "content-type": "application/json" });
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        deleteAllConfirmation: "DELETE",
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
        body: JSON.stringify({ deleteAllConfirmation: "DELETE" }),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://api.internal${runHistoryPath}`);
    expect(payload.deletedSummaryCount).toBe(3);
  });

  it("forwards admin runtime policy reads and updates with the server-side control token", async () => {
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
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );

      if (String(input).endsWith(adminPresetListPath)) {
        expect(init?.method).toBe("GET");
        return jsonResponse({
          presets: [{ ...demoPresetPayload("custom"), canArchive: false }],
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

  it("forwards admin preset archival as a validated DELETE on the preset list path", async () => {
    const headers = await adminSessionHeaders({ "content-type": "application/json" });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`http://api.internal${adminPresetListPath}`);
      expect(init?.method).toBe("DELETE");
      expect((init?.headers as Record<string, string>)[controlServiceTokenHeaderName]).toBe(
        "control-token",
      );
      expect(JSON.parse(String(init?.body))).toEqual({ slug: "operator-duplicate" });
      return jsonResponse({
        slug: "operator-duplicate",
        archivedAt: "2026-06-20T00:00:10.000Z",
        timestamp: "2026-06-20T00:00:10.000Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const unauthorized = await archiveAdminPreset(
      new Request("http://dashboard.local/api/admin/demo/presets", {
        method: "DELETE",
        headers: { origin: "http://dashboard.local" },
        body: JSON.stringify({ slug: "operator-duplicate" }),
      }),
    );
    const invalidBody = await archiveAdminPreset(
      new Request("http://dashboard.local/api/admin/demo/presets", {
        method: "DELETE",
        headers,
        body: JSON.stringify({ slug: "  " }),
      }),
    );
    const authorized = await archiveAdminPreset(
      new Request("http://dashboard.local/api/admin/demo/presets", {
        method: "DELETE",
        headers,
        body: JSON.stringify({ slug: "operator-duplicate" }),
      }),
    );
    const payload = await authorized.json();

    expect(unauthorized.status).toBe(401);
    expect(invalidBody.status).toBe(400);
    expect(authorized.status).toBe(200);
    expect(payload.slug).toBe("operator-duplicate");
    expect(payload.archivedAt).toBe("2026-06-20T00:00:10.000Z");
    expect(fetchMock).toHaveBeenCalledOnce();
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
    defaultConfig: erpChaosConfigPayload(),
    updatedAt: "2026-06-20T00:00:10.000Z",
    effectiveSafetyCaps: {
      maxLatencyMs: 5000,
      minMaxTps: 1,
      maxErrorRate: 1,
      allowForcedOutage: true,
    },
  };
}

function dashboardRecoveryPayload(correlationId = "corr-recovery") {
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    correlationId,
    scopeId: dashboardProjectionScopeId(null),
    revision: 1,
    scope: null,
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    erp: null,
    systemStatus: null,
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
      configSnapshot: configSnapshotPayload(),
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

function publicRuntimePolicyPayload() {
  return {
    estimatedDemoOccupancyCeilingSeconds: 600,
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
      allowedTrafficModes: ["buyer-spike" as const, "constant-arrival-rate" as const],
    },
    deploymentHardCaps: {
      estimatedDemoOccupancyCeilingSeconds: 600,
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
    estimatedDemoOccupancyCeilingSeconds: policy.estimatedDemoOccupancyCeilingSeconds,
    isPublicRunBudgetEnforced: policy.isPublicRunBudgetEnforced,
    publicRunBudget: {
      windowSeconds: 120,
      perVisitorMaxStarts: 1,
      globalMaxStarts: 3,
    },
    publicCustomDefaults: policy.publicCustomDefaults,
    publicCustomLimits: {
      ...policy.publicCustomLimits,
      maxBuyers: 1500,
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
    origin: "http://dashboard.local",
    ...headers,
    cookie: await adminSessionCookie(),
  };
}

async function adminSessionCookie(): Promise<string> {
  const response = await createAdminSession(
    new Request("http://dashboard.local/api/admin/session", {
      method: "POST",
      headers: { origin: "http://dashboard.local" },
      body: JSON.stringify({ passphrase: "admin-pass" }),
    }),
  );
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";

  expect(response.status).toBe(200);
  expect(cookie).toContain("checkout_surge_admin_session=");

  return cookie;
}

function jsonResponse(payload: unknown, status = 200): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (payload && typeof payload === "object" && "correlationId" in payload) {
    const value = (payload as Record<string, unknown>).correlationId;
    if (typeof value === "string") {
      headers[correlationIdHeaderName] = value;
    }
  }
  return new Response(JSON.stringify(payload), { status, headers });
}
