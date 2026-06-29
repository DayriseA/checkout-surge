import { createHmac, timingSafeEqual } from "node:crypto";
import { controlServiceTokenHeaderName } from "@checkout-surge/contracts";
import { adminPassphraseHeaderName } from "../control-paths";

const DEFAULT_API_BASE_URL = "http://localhost:4000";
const DEFAULT_MOCK_ERP_BASE_URL = "http://localhost:4100";
export const adminSessionCookieName = "checkout_surge_admin_session" as const;

interface ContractSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

export function mockErpBaseUrl(): string {
  return (process.env.MOCK_ERP_BASE_URL ?? DEFAULT_MOCK_ERP_BASE_URL).replace(/\/+$/, "");
}

export function requireAdminPassphrase(request: Request): Response | null {
  const expectedPassphrase = process.env.ADMIN_DASHBOARD_PASSPHRASE?.trim();

  if (!expectedPassphrase) {
    return jsonError(503, "admin_passphrase_not_configured", "Admin controls are not configured.");
  }

  if (hasValidAdminSession(request)) {
    return null;
  }

  const suppliedPassphrase = request.headers.get(adminPassphraseHeaderName)?.trim();

  if (suppliedPassphrase === expectedPassphrase) {
    return null;
  }

  return jsonError(401, "admin_passphrase_required", "A valid admin passphrase is required.");
}

export function createAdminSessionCookie(now: Date = new Date()): string | Response {
  const secret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (!secret) {
    return jsonError(
      503,
      "admin_session_secret_not_configured",
      "Admin sessions are not configured.",
    );
  }

  const maxAgeSeconds = parsePositiveInteger(
    process.env.ADMIN_SESSION_MAX_AGE_SECONDS,
    8 * 60 * 60,
  );
  const expiresAt = new Date(now.getTime() + maxAgeSeconds * 1000);
  const payload = `${expiresAt.getTime()}`;
  const signature = signAdminSession(payload, secret);
  const value = `${payload}.${signature}`;

  return `${adminSessionCookieName}=${encodeURIComponent(value)}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax`;
}

function hasValidAdminSession(request: Request): boolean {
  const secret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (!secret) {
    return false;
  }

  const value = readCookie(request, adminSessionCookieName);
  if (!value) {
    return false;
  }

  const [expiresAtRaw, signature] = value.split(".");
  if (!expiresAtRaw || !signature) {
    return false;
  }

  const expiresAtMs = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return false;
  }

  const expected = signAdminSession(expiresAtRaw, secret);
  return safeEqual(signature, expected);
}

export function requireControlServiceToken(): string | Response {
  const token = process.env.CONTROL_SERVICE_TOKEN?.trim();

  if (!token) {
    return jsonError(
      503,
      "control_token_not_configured",
      "Service control token is not configured.",
    );
  }

  return token;
}

export async function readJsonRequest(request: Request): Promise<unknown | Response> {
  try {
    return await request.json();
  } catch {
    return jsonError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function validateJson<T>(input: unknown, schema: ContractSchema<T>): T | Response {
  const parsed = schema.safeParse(input);

  if (parsed.success) {
    return parsed.data;
  }

  return jsonError(400, "invalid_request", "Request body did not match the shared contract.");
}

export async function proxyJson<T>(options: {
  url: string;
  method: "DELETE" | "GET" | "POST" | "PUT";
  schema: ContractSchema<T>;
  body?: unknown;
  headers?: HeadersInit;
}): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(options.url, {
      method: options.method,
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    return jsonError(
      502,
      "backend_unavailable",
      error instanceof Error ? error.message : "Backend service is unavailable.",
    );
  }

  const payload = await readResponseJson(response);

  if (!payload.ok) {
    return jsonError(502, "invalid_backend_response", payload.reason);
  }

  if (!response.ok) {
    return Response.json(payload.value, { status: response.status });
  }

  const parsed = options.schema.safeParse(payload.value);

  if (!parsed.success) {
    return jsonError(
      502,
      "invalid_backend_response",
      "Backend response did not match the shared contract.",
    );
  }

  return Response.json(parsed.data, { status: response.status });
}

export function controlTokenHeaders(token: string): HeadersInit {
  return {
    [controlServiceTokenHeaderName]: token,
  };
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValueParts.join("="));
    }
  }

  return null;
}

function signAdminSession(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readResponseJson(
  response: Response,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: await response.json() };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Backend returned non-JSON data.",
    };
  }
}
