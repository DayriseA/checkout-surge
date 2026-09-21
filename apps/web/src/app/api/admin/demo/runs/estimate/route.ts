import {
  previewDemoRunPath,
  previewDemoRunRequestSchema,
  previewDemoRunResponseSchema,
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

  const payload = await parseJsonRequest(ctx, previewDemoRunRequestSchema);
  if (payload instanceof Response) {
    return payload;
  }

  return admin.proxyJson({
    url: `${apiBaseUrl()}${previewDemoRunPath}`,
    method: "POST",
    schema: previewDemoRunResponseSchema,
    body: payload,
  });
}
