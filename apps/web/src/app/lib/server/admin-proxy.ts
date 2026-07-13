import {
  controlServiceTokenHeaderName,
  demoRunOperatorModeHeaderName,
} from "@checkout-surge/contracts";
import { requireAdminOrigin } from "./admin-origin";
import { isValidAdminSessionToken, parseAdminSessionMaxAge } from "./admin-session";
import { adminSessionCookieName, jsonError, proxyJson } from "./backend-proxy";
import { readWebSecret } from "./config";

interface ContractSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

export interface AdminProxyCapability {
  proxyJson<T>(options: {
    url: string;
    method: "DELETE" | "GET" | "POST" | "PUT";
    schema: ContractSchema<T>;
    body?: unknown;
  }): Promise<Response>;
}

export function authorizeAdminProxy(
  request: Request,
  options: { operatorMode?: "admin" } = {},
): AdminProxyCapability | Response {
  const originFailure = requireAdminOrigin(request);
  if (originFailure) return originFailure;

  const secret = readWebSecret(process.env, "ADMIN_SESSION_SECRET");
  const maxAgeSeconds = parseAdminSessionMaxAge(process.env.ADMIN_SESSION_MAX_AGE_SECONDS);
  if (!secret)
    return jsonError(
      503,
      "admin_session_secret_not_configured",
      "Admin sessions are not configured.",
    );
  if (maxAgeSeconds === null)
    return jsonError(503, "admin_session_config_invalid", "Admin sessions are not configured.");

  const token = readCookie(request, adminSessionCookieName);
  if (
    !token ||
    !isValidAdminSessionToken({
      token,
      secret,
      nowSeconds: Math.floor(Date.now() / 1000),
      maxAgeSeconds,
    })
  ) {
    return jsonError(401, "admin_session_required", "A valid admin session is required.");
  }

  const serviceToken = readWebSecret(process.env, "CONTROL_SERVICE_TOKEN");
  if (!serviceToken)
    return jsonError(
      503,
      "control_token_not_configured",
      "Service control token is not configured.",
    );

  const privilegedHeaders: Record<string, string> = {
    [controlServiceTokenHeaderName]: serviceToken,
  };
  if (options.operatorMode) privilegedHeaders[demoRunOperatorModeHeaderName] = options.operatorMode;
  return Object.freeze({
    proxyJson<T>(proxyOptions: {
      url: string;
      method: "DELETE" | "GET" | "POST" | "PUT";
      schema: ContractSchema<T>;
      body?: unknown;
    }): Promise<Response> {
      return proxyJson({ ...proxyOptions, headers: privilegedHeaders });
    },
  });
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [cookieName, ...value] = part.trim().split("=");
    if (cookieName !== name) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return null;
    }
  }
  return null;
}
