import {
  controlServiceTokenHeaderName,
  demoRunOperatorModeHeaderName,
} from "@checkout-surge/contracts";
import { requireAdminOrigin } from "./admin-origin";
import { isValidAdminSessionToken } from "./admin-session";
import {
  adminSessionCookieName,
  jsonError,
  type ProxyRequestContext,
  proxyJson,
} from "./backend-proxy";
import { webServerConfig } from "./config";

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
  ctx: ProxyRequestContext,
  options: { operatorMode?: "admin" } = {},
): AdminProxyCapability | Response {
  const originFailure = requireAdminOrigin(ctx);
  if (originFailure) return originFailure;

  const config = webServerConfig();
  const secret = config.adminSessionSecret;
  const maxAgeSeconds = config.adminSessionMaxAgeSeconds;

  const token = readCookie(ctx.request, adminSessionCookieName);
  if (
    !token ||
    !isValidAdminSessionToken({
      token,
      secret,
      nowSeconds: Math.floor(Date.now() / 1000),
      maxAgeSeconds,
    })
  ) {
    return jsonError(ctx, 401, "admin_session_required", "A valid admin session is required.");
  }

  const serviceToken = config.controlServiceToken;

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
      return proxyJson({ ctx, ...proxyOptions, headers: privilegedHeaders });
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
