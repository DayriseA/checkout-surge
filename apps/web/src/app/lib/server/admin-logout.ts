import { correlationIdHeaderName } from "@checkout-surge/logger";
import { requireAdminOrigin } from "./admin-origin";
import { adminSessionCookieName, createProxyRequestContext } from "./backend-proxy";
import { webServerConfig } from "./config";

export async function handleAdminLogout(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const originFailure = requireAdminOrigin(ctx);
  if (originFailure) return originFailure;
  const headers = new Headers();
  headers.set(
    "set-cookie",
    `${adminSessionCookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${webServerConfig().secureAdminCookie ? "; Secure" : ""}`,
  );
  headers.set(correlationIdHeaderName, ctx.correlationId);
  return Response.json({ authenticated: false }, { headers });
}
