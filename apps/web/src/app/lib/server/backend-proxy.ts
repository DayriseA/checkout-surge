import { controlServiceTokenHeaderName } from "@checkout-surge/contracts";
import { webServerConfig } from "./config";
export const adminSessionCookieName = "checkout_surge_admin_session" as const;

interface ContractSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export function apiBaseUrl(): string {
  return webServerConfig().apiBaseUrl;
}

export function mockErpBaseUrl(): string {
  return webServerConfig().mockErpBaseUrl;
}

export function requireControlServiceToken(): string | Response {
  return webServerConfig().controlServiceToken;
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
    const headers = new Headers();
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    return Response.json(payload.value, { status: response.status, headers });
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

export function jsonError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  return Response.json({ code, message }, { status, ...(headers ? { headers } : {}) });
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
