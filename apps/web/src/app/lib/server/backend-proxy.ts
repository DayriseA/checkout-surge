import {
  controlServiceTokenHeaderName,
  correlationIdSchema,
  demoRunOperatorModeHeaderName,
  type ErrorPayloadCode,
  errorPayloadSchema,
  publicVisitorIdHeaderName,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, normalizeCorrelationId } from "@checkout-surge/logger";
import { webServerConfig } from "./config";

export const adminSessionCookieName = "checkout_surge_admin_session" as const;

const forwardedHeaderAllowList = new Set<string>([
  controlServiceTokenHeaderName,
  demoRunOperatorModeHeaderName,
  publicVisitorIdHeaderName,
]);

interface ContractSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export interface ProxyRequestContext {
  request: Request;
  correlationId: string;
}

export function createProxyRequestContext(request: Request): ProxyRequestContext {
  return {
    request,
    correlationId: normalizeCorrelationId(request.headers.get(correlationIdHeaderName)),
  };
}

export function apiBaseUrl(): string {
  return webServerConfig().apiBaseUrl;
}

export function mockErpBaseUrl(): string {
  return webServerConfig().mockErpBaseUrl;
}

export function requireControlServiceToken(ctx: ProxyRequestContext): string | Response {
  const token = webServerConfig().controlServiceToken;
  if (!token) {
    return jsonError(ctx, 503, "service_misconfigured", "Control service token is not configured.");
  }
  return token;
}

export async function readJsonRequest(ctx: ProxyRequestContext): Promise<unknown | Response> {
  try {
    return await ctx.request.json();
  } catch {
    return jsonError(ctx, 400, "invalid_request", "Request body must be valid JSON.");
  }
}

export function validateJson<T>(
  ctx: ProxyRequestContext,
  input: unknown,
  schema: ContractSchema<T>,
): T | Response {
  const parsed = schema.safeParse(input);

  if (parsed.success) {
    return parsed.data;
  }

  return jsonError(ctx, 400, "invalid_request", "Request body did not match the shared contract.");
}

export async function proxyJson<T>(options: {
  acceptedContractStatuses?: readonly number[];
  ctx: ProxyRequestContext;
  url: string;
  method: "DELETE" | "GET" | "POST" | "PUT";
  schema: ContractSchema<T>;
  body?: unknown;
  headers?: HeadersInit;
}): Promise<Response> {
  const ctx = options.ctx;
  const outboundHeaders: Record<string, string> = {
    accept: "application/json",
    [correlationIdHeaderName]: ctx.correlationId,
  };
  if (options.body !== undefined) {
    outboundHeaders["content-type"] = "application/json";
  }
  if (options.headers) {
    for (const [name, value] of new Headers(options.headers)) {
      if (forwardedHeaderAllowList.has(name)) {
        outboundHeaders[name] = value;
      }
    }
  }
  outboundHeaders[correlationIdHeaderName] = ctx.correlationId;

  let response: Response;
  try {
    response = await fetch(options.url, {
      method: options.method,
      cache: "no-store",
      headers: outboundHeaders,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    return jsonError(ctx, 502, "backend_unavailable", "Backend service is unavailable.");
  }

  const body = await readResponseBody(response);

  if (!body.ok) {
    return jsonError(ctx, 502, "invalid_backend_response", "Backend returned an invalid response.");
  }

  if (!response.ok && !options.acceptedContractStatuses?.includes(response.status)) {
    const parsed = errorPayloadSchema.safeParse(body.value);
    if (!parsed.success) {
      return jsonError(
        ctx,
        502,
        "invalid_backend_response",
        "Backend returned an invalid response.",
      );
    }
    const selectedCorrelation = resolveUpstreamErrorCorrelation(
      ctx,
      response,
      parsed.data.correlationId,
    );
    if (selectedCorrelation instanceof Response) {
      return selectedCorrelation;
    }
    const headers = new Headers();
    headers.set(correlationIdHeaderName, selectedCorrelation);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      headers.set("retry-after", retryAfter);
    }
    return Response.json(parsed.data, { status: response.status, headers });
  }

  const parsed = options.schema.safeParse(body.value);

  if (!parsed.success) {
    return jsonError(
      ctx,
      502,
      "invalid_backend_response",
      "Backend response did not match the shared contract.",
    );
  }

  const upstream = readUpstreamCorrelation(response);
  if (upstream.present && !upstream.valid) {
    return jsonError(ctx, 502, "invalid_backend_response", "Backend returned an invalid response.");
  }
  const selectedCorrelation = upstream.present ? upstream.value : ctx.correlationId;
  const bodyCorrelation = readBodyCorrelation(parsed.data);
  if (bodyCorrelation !== null && bodyCorrelation !== selectedCorrelation) {
    return jsonError(ctx, 502, "invalid_backend_response", "Backend returned an invalid response.");
  }

  const headers = new Headers();
  headers.set(correlationIdHeaderName, selectedCorrelation);
  return Response.json(parsed.data, { status: response.status, headers });
}

export function jsonError(
  ctx: ProxyRequestContext,
  status: number,
  code: ErrorPayloadCode,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  const payload = errorPayloadSchema.parse({
    code,
    message,
    correlationId: ctx.correlationId,
    timestamp: new Date().toISOString(),
  });
  const headers = new Headers();
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value);
    }
  }
  headers.set(correlationIdHeaderName, ctx.correlationId);
  return Response.json(payload, { status, headers });
}

function resolveUpstreamErrorCorrelation(
  ctx: ProxyRequestContext,
  response: Response,
  bodyCorrelation: string,
): string | Response {
  const upstream = readUpstreamCorrelation(response);
  if (!upstream.present) {
    return bodyCorrelation;
  }
  if (!upstream.valid || upstream.value !== bodyCorrelation) {
    return jsonError(ctx, 502, "invalid_backend_response", "Backend returned an invalid response.");
  }
  return upstream.value;
}

function readUpstreamCorrelation(
  response: Response,
):
  | { present: false }
  | { present: true; valid: true; value: string }
  | { present: true; valid: false } {
  const raw = response.headers.get(correlationIdHeaderName);
  if (raw === null) {
    return { present: false };
  }
  const parsed = correlationIdSchema.safeParse(raw.trim());
  return parsed.success
    ? { present: true, valid: true, value: parsed.data }
    : { present: true, valid: false };
}

function readBodyCorrelation(data: unknown): string | null {
  if (data && typeof data === "object" && "correlationId" in data) {
    const value = (data as Record<string, unknown>).correlationId;
    return typeof value === "string" ? value : null;
  }
  return null;
}

async function readResponseBody(
  response: Response,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false };
  }
}
