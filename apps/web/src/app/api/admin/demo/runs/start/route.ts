import {
  startDemoRunPath,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../../lib/server/admin-proxy";
import {
  apiBaseUrl,
  createProxyRequestContext,
  parseJsonRequest,
} from "../../../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx, { operatorMode: "admin" });
  if (admin instanceof Response) return admin;

  const payload = await parseJsonRequest(ctx, startDemoRunRequestSchema);
  if (payload instanceof Response) {
    return payload;
  }

  return admin.proxyJson({
    url: `${apiBaseUrl()}${startDemoRunPath}`,
    method: "POST",
    schema: startDemoRunResponseSchema,
    body: payload,
  });
}
