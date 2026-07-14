import type { ErrorPayloadCode } from "@checkout-surge/contracts";
import type { ProxyRequestContext } from "./backend-proxy";
import { jsonError } from "./backend-proxy";
import { webServerConfig } from "./config";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireAdminOrigin(ctx: ProxyRequestContext): Response | null {
  if (safeMethods.has(ctx.request.method.toUpperCase())) return null;
  const allowed = webServerConfig().webOrigins;
  const supplied = ctx.request.headers.get("origin");
  return supplied && allowed.includes(supplied)
    ? null
    : originError(ctx, "admin_origin_required", "A trusted admin origin is required.");
}

function originError(ctx: ProxyRequestContext, code: ErrorPayloadCode, message: string): Response {
  return jsonError(ctx, 403, code, message);
}
