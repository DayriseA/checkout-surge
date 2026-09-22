import {
  controlServiceTokenHeaderName,
  demoRunOperatorModeHeaderName,
  type ErrorPayload,
  errorPayloadSchema,
  publicVisitorIdHeaderName,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName } from "@checkout-surge/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdminLoginHandler,
  defaultAdminLoginDependencies,
} from "../src/app/lib/server/admin-login.js";
import { authorizeAdminProxy } from "../src/app/lib/server/admin-proxy.js";
import {
  createProxyRequestContext,
  jsonError,
  type ProxyRequestContext,
  parseJsonRequest,
  proxyJson,
  requireControlServiceToken,
} from "../src/app/lib/server/backend-proxy.js";
import {
  initializeWebServerConfig,
  resetWebServerConfigForTests,
  type WebServerConfig,
  webServerConfig,
} from "../src/app/lib/server/config.js";
import { resolvePublicVisitorIdentity } from "../src/app/lib/server/public-visitor.js";

const configKey = Symbol.for("checkout-surge.web-server-config");

function injectConfig(overrides: Partial<WebServerConfig> = {}): void {
  resetWebServerConfigForTests();
  process.env.WEB_ORIGIN = "http://dashboard.local";
  process.env.ADMIN_DASHBOARD_PASSPHRASE = "admin-pass";
  process.env.ADMIN_SESSION_SECRET = "admin-session-secret";
  process.env.CONTROL_SERVICE_TOKEN = "control-token";
  process.env.PUBLIC_CLIENT_COOKIE_SECRET = "public-cookie-secret";
  process.env.API_BASE_URL = "http://api.internal";
  process.env.MOCK_ERP_BASE_URL = "http://mock-erp.internal";
  const base = initializeWebServerConfig(process.env);
  resetWebServerConfigForTests();
  (globalThis as unknown as Record<symbol, unknown>)[configKey] = Object.freeze({
    ...base,
    ...overrides,
  });
}

function ctxWith(correlationId: string, request?: Request): ProxyRequestContext {
  return {
    request: request ?? new Request("http://dashboard.local/api/admin/test"),
    correlationId,
  };
}

function canonicalError(
  code: string,
  correlationId: string,
  message = "Backend rejected the request.",
): ErrorPayload {
  return errorPayloadSchema.parse({
    code,
    message,
    correlationId,
    timestamp: "2026-06-20T00:00:00.000Z",
  });
}

function rawError(code: string, correlationId: string): Record<string, unknown> {
  return {
    code,
    message: "Backend rejected the request.",
    correlationId,
    timestamp: "2026-06-20T00:00:00.000Z",
  };
}

function upstreamResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function readOutboundHeaders(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return (headers as Record<string, string>) ?? {};
}

interface SimpleSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

function objectSchema<T extends Record<string, unknown>>(required: (keyof T)[]): SimpleSchema<T> {
  return {
    safeParse(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { success: false, error: { message: "not an object" } };
      }
      const record = input as Record<string, unknown>;
      for (const key of required) {
        if (!(key in record)) {
          return { success: false, error: { message: `missing ${String(key)}` } };
        }
      }
      const allowed = new Set<string>(required as string[]);
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          return { success: false, error: { message: `extra ${key}` } };
        }
      }
      return { success: true, data: record as T };
    },
  };
}

const successSchema = objectSchema<{ ok: boolean }>(["ok"]);
const successWithCorrelationSchema = objectSchema<{ ok: boolean; correlationId: string }>([
  "ok",
  "correlationId",
]);

describe("backend proxy request context", () => {
  beforeEach(() => injectConfig());
  afterEach(() => {
    resetWebServerConfigForTests();
    vi.unstubAllGlobals();
  });

  it("forwards a valid browser correlation id to the backend", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(readOutboundHeaders(init)[correlationIdHeaderName]).toBe("browser-corr-1");
      return upstreamResponse({ ok: true }, 200, { [correlationIdHeaderName]: "browser-corr-1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = ctxWith("browser-corr-1");
    const response = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "GET",
      schema: successSchema,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get(correlationIdHeaderName)).toBe("browser-corr-1");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
    ["oversized", "x".repeat(200)],
    ["malformed", "not a corr!!"],
  ])("replaces %s browser correlation with one generated id reused throughout", async (kind, headerValue) => {
    void kind;
    const request = new Request("http://dashboard.local/api/admin/test", {
      headers: headerValue === undefined ? {} : { [correlationIdHeaderName]: headerValue },
    });
    const ctx = createProxyRequestContext(request);
    expect(ctx.correlationId).toHaveLength(36);
    expect(ctx.correlationId).toMatch(/^[0-9a-f-]{36}$/);

    let forwardedId: string | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedId = readOutboundHeaders(init)[correlationIdHeaderName];
      return upstreamResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "GET",
      schema: successSchema,
    });

    expect(forwardedId).toBe(ctx.correlationId);
    expect(response.headers.get(correlationIdHeaderName)).toBe(ctx.correlationId);
  });

  it("returns canonical local envelopes with the request correlation id and header", async () => {
    const ctx = ctxWith("local-corr");

    const originFailure = authorizeAdminProxy(
      ctxWith(
        "local-corr",
        new Request("http://dashboard.local/api/admin/test", { method: "POST" }),
      ),
    );
    expect(originFailure).toBeInstanceOf(Response);
    const originResponse = originFailure as Response;
    expect(originResponse.status).toBe(403);
    expect(errorPayloadSchema.parse(await originResponse.json()).code).toBe(
      "admin_origin_required",
    );
    expect(originResponse.headers.get(correlationIdHeaderName)).toBe("local-corr");

    const sessionFailure = authorizeAdminProxy(ctx);
    const sessionResponse = sessionFailure as Response;
    expect(sessionResponse.status).toBe(401);
    expect(errorPayloadSchema.parse(await sessionResponse.json()).code).toBe(
      "admin_session_required",
    );
    expect(sessionResponse.headers.get(correlationIdHeaderName)).toBe("local-corr");
  });

  it("parses and validates JSON request bodies", async () => {
    const parsed = await parseJsonRequest(
      ctxWith(
        "parse-corr",
        new Request("http://dashboard.local", {
          method: "POST",
          body: JSON.stringify({ ok: true }),
        }),
      ),
      successSchema,
    );

    expect(parsed).toEqual({ ok: true });
  });

  it("distinguishes malformed JSON from valid JSON that violates the contract", async () => {
    const jsonFailure = await parseJsonRequest(
      ctxWith(
        "local-corr",
        new Request("http://dashboard.local", { method: "POST", body: "not-json" }),
      ),
      successSchema,
    );
    const jsonResponse = jsonFailure as Response;
    expect(jsonResponse.status).toBe(400);
    expect(errorPayloadSchema.parse(await jsonResponse.json())).toMatchObject({
      code: "invalid_request",
      correlationId: "local-corr",
      message: "Request body must be valid JSON.",
    });
    expect(jsonResponse.headers.get(correlationIdHeaderName)).toBe("local-corr");

    const validationFailure = await parseJsonRequest(
      ctxWith(
        "local-corr",
        new Request("http://dashboard.local", {
          method: "POST",
          body: JSON.stringify({ unexpected: true }),
        }),
      ),
      successSchema,
    );
    const validationResponse = validationFailure as Response;
    expect(validationResponse.status).toBe(400);
    expect(errorPayloadSchema.parse(await validationResponse.json())).toMatchObject({
      code: "invalid_request",
      correlationId: "local-corr",
      message: "Request body did not match the shared contract.",
    });
    expect(validationResponse.headers.get(correlationIdHeaderName)).toBe("local-corr");
  });

  it("returns a canonical control-token-not-configured envelope when the token is missing", async () => {
    injectConfig({ controlServiceToken: "" });
    const tokenResponse = requireControlServiceToken(ctxWith("token-corr")) as Response;
    expect(tokenResponse.status).toBe(503);
    expect(errorPayloadSchema.parse(await tokenResponse.json()).code).toBe("service_misconfigured");
    expect(tokenResponse.headers.get(correlationIdHeaderName)).toBe("token-corr");
  });

  it("does not leak exception text from network or parser failures", async () => {
    const ctx = ctxWith("leak-corr");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("super secret internal connection refused 10.0.0.5:5432");
      }),
    );
    const networkResponse = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "GET",
      schema: successSchema,
    });
    expect(networkResponse.status).toBe(502);
    const networkBody = errorPayloadSchema.parse(await networkResponse.json());
    expect(networkBody.code).toBe("backend_unavailable");
    expect(networkBody.message).toBe("Backend service is unavailable.");
    expect(JSON.stringify(networkBody)).not.toMatch(/secret|10\.0\.0\.5|5432|connection/i);
    expect(networkResponse.headers.get(correlationIdHeaderName)).toBe("leak-corr");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>not json</html>", { headers: { "content-type": "text/html" } }),
      ),
    );
    const parserResponse = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "GET",
      schema: successSchema,
    });
    expect(parserResponse.status).toBe(502);
    expect(errorPayloadSchema.parse(await parserResponse.json()).code).toBe(
      "invalid_backend_response",
    );
  });

  it("forwards only allow-listed server-owned headers and never browser secrets", async () => {
    const browserRequest = new Request("http://dashboard.local/api/admin/test", {
      method: "POST",
      headers: {
        cookie: "checkout_surge_admin_session=stolen",
        authorization: "Bearer stolen",
        "x-arbitrary-browser-header": "browser-only",
        [correlationIdHeaderName]: "browser-corr",
      },
      body: JSON.stringify({ ok: true }),
    });
    const ctx = createProxyRequestContext(browserRequest);

    let captured: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        captured = readOutboundHeaders(init);
        return upstreamResponse({ ok: true }, 200, { [correlationIdHeaderName]: "browser-corr" });
      }),
    );

    await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "POST",
      schema: successSchema,
      body: { ok: true },
      headers: {
        [controlServiceTokenHeaderName]: "control-token",
        [demoRunOperatorModeHeaderName]: "public",
        [publicVisitorIdHeaderName]: "visitor-credential",
        authorization: "Bearer forbidden",
        cookie: "checkout_surge_admin_session=stolen",
        "x-arbitrary-caller-header": "caller-only",
        [correlationIdHeaderName]: "attempted-override",
        "X-CORRELATION-ID": "attempted-override-2",
      },
    });

    expect(captured[correlationIdHeaderName]).toBe("browser-corr");
    expect(captured.accept).toBe("application/json");
    expect(captured["content-type"]).toBe("application/json");
    expect(captured[controlServiceTokenHeaderName]).toBe("control-token");
    expect(captured[demoRunOperatorModeHeaderName]).toBe("public");
    expect(captured[publicVisitorIdHeaderName]).toBe("visitor-credential");
    expect(captured.cookie).toBeUndefined();
    expect(captured.authorization).toBeUndefined();
    expect(captured["x-arbitrary-browser-header"]).toBeUndefined();
    expect(captured["x-arbitrary-caller-header"]).toBeUndefined();
  });

  it("preserves a canonical upstream error status, body, header, and retry-after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        upstreamResponse(canonicalError("preset_conflict", "upstream-corr"), 409, {
          [correlationIdHeaderName]: "upstream-corr",
          "retry-after": "30",
        }),
      ),
    );
    const ctx = ctxWith("bff-corr");
    const response = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "POST",
      schema: successSchema,
    });

    expect(response.status).toBe(409);
    expect(response.headers.get(correlationIdHeaderName)).toBe("upstream-corr");
    expect(response.headers.get("retry-after")).toBe("30");
    expect(errorPayloadSchema.parse(await response.json())).toMatchObject({
      code: "preset_conflict",
      correlationId: "upstream-corr",
    });
  });

  it("recovers the upstream error header from the canonical body when missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => upstreamResponse(canonicalError("run_conflict", "body-corr"), 409)),
    );
    const ctx = ctxWith("bff-corr");
    const response = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "POST",
      schema: successSchema,
    });

    expect(response.status).toBe(409);
    expect(response.headers.get(correlationIdHeaderName)).toBe("body-corr");
    expect(errorPayloadSchema.parse(await response.json()).correlationId).toBe("body-corr");
  });

  it.each([
    ["non-JSON", () => new Response("not json", { headers: { "content-type": "text/plain" } })],
    ["malformed shape", () => upstreamResponse({ weird: "shape" }, 409)],
    ["unknown code", () => upstreamResponse(rawError("notfound", "x"), 409)],
    [
      "body/header mismatch",
      () =>
        upstreamResponse(canonicalError("run_conflict", "body-corr"), 409, {
          [correlationIdHeaderName]: "header-corr",
        }),
    ],
    [
      "invalid header",
      () =>
        upstreamResponse(canonicalError("run_conflict", "body-corr"), 409, {
          [correlationIdHeaderName]: "x".repeat(200),
        }),
    ],
  ])("canonicalizes %s upstream errors to a 502 BFF envelope", async (_name, buildResponse) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => buildResponse()),
    );
    const ctx = ctxWith("bff-corr");
    const response = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "GET",
      schema: successSchema,
    });

    expect(response.status).toBe(502);
    const body = errorPayloadSchema.parse(await response.json());
    expect(body.code).toBe("invalid_backend_response");
    expect(body.correlationId).toBe("bff-corr");
    expect(response.headers.get(correlationIdHeaderName)).toBe("bff-corr");
  });

  it("preserves the upstream success correlation header and agrees with the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        upstreamResponse({ ok: true, correlationId: "success-corr" }, 200, {
          [correlationIdHeaderName]: "success-corr",
        }),
      ),
    );
    const ctx = ctxWith("bff-corr");
    const response = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "GET",
      schema: successWithCorrelationSchema,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get(correlationIdHeaderName)).toBe("success-corr");
    expect(await response.json()).toEqual({ ok: true, correlationId: "success-corr" });
  });

  it("falls back to the BFF request id for success bodies without correlation context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => upstreamResponse({ ok: true }, 200)),
    );
    const ctx = ctxWith("bff-fallback");
    const response = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "GET",
      schema: successSchema,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get(correlationIdHeaderName)).toBe("bff-fallback");
  });

  it("rejects a success body whose correlation disagrees with the response header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        upstreamResponse({ ok: true, correlationId: "body-corr" }, 200, {
          [correlationIdHeaderName]: "header-corr",
        }),
      ),
    );
    const ctx = ctxWith("bff-corr");
    const response = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "GET",
      schema: successWithCorrelationSchema,
    });

    expect(response.status).toBe(502);
    expect(errorPayloadSchema.parse(await response.json()).code).toBe("invalid_backend_response");
  });

  it("carries one browser id end-to-end through request header, upstream error, and browser response", async () => {
    const browserRequest = new Request("http://dashboard.local/api/admin/test", {
      method: "POST",
      headers: { [correlationIdHeaderName]: "e2e-corr" },
      body: JSON.stringify({ ok: true }),
    });
    const ctx = createProxyRequestContext(browserRequest);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(readOutboundHeaders(init)[correlationIdHeaderName]).toBe("e2e-corr");
        return upstreamResponse(canonicalError("resource_not_found", "e2e-corr"), 404, {
          [correlationIdHeaderName]: "e2e-corr",
        });
      }),
    );

    const response = await proxyJson({
      ctx,
      url: "http://api.internal/probe",
      method: "POST",
      schema: successSchema,
    });

    expect(response.status).toBe(404);
    expect(response.headers.get(correlationIdHeaderName)).toBe("e2e-corr");
    expect(errorPayloadSchema.parse(await response.json()).correlationId).toBe("e2e-corr");
  });

  it("stamps the admin login success response with the request correlation header", async () => {
    const handler = createAdminLoginHandler({
      ...defaultAdminLoginDependencies,
      limiter: () =>
        ({
          admit: async () => ({ outcome: "admitted" as const }),
        }) as never,
      resolveClient: () => "client",
      config: () => ({
        passphrase: "admin-pass",
        sessionSecret: webServerConfig().adminSessionSecret,
        sessionMaxAgeSeconds: webServerConfig().adminSessionMaxAgeSeconds,
        secureCookie: false,
      }),
      now: () => new Date(0),
    });

    const response = await handler(
      new Request("http://dashboard.local/api/admin/session", {
        method: "POST",
        headers: { origin: "http://dashboard.local" },
        body: JSON.stringify({ passphrase: "admin-pass" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("checkout_surge_admin_session=");
    expect(response.headers.get(correlationIdHeaderName)).toHaveLength(36);
  });

  it("returns a canonical public visitor error when the cookie secret is missing", async () => {
    injectConfig({ publicClientCookieSecret: "" });
    const ctx = createProxyRequestContext(
      new Request("http://dashboard.local/api/dashboard/recovery"),
    );
    const result = resolvePublicVisitorIdentity(ctx);
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(503);
    expect(errorPayloadSchema.parse(await response.json()).code).toBe("service_misconfigured");
    expect(response.headers.get(correlationIdHeaderName)).toBe(ctx.correlationId);
  });

  it("builds a canonical local error envelope merging safe extra headers", async () => {
    const ctx = ctxWith("extra-corr");
    const response = jsonError(ctx, 429, "admin_login_rate_limited", "rate limited", {
      "retry-after": "5",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get(correlationIdHeaderName)).toBe("extra-corr");
    const body = errorPayloadSchema.parse(await response.json());
    expect(body.code).toBe("admin_login_rate_limited");
    expect(body.correlationId).toBe("extra-corr");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
