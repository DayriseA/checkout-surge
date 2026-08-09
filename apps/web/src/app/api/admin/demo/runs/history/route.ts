import {
  adminDeleteRunHistoryRequestSchema,
  adminDeleteRunHistoryResponseSchema,
  runHistoryPath,
} from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../../lib/server/admin-proxy";
import {
  apiBaseUrl,
  createProxyRequestContext,
  parseJsonRequest,
} from "../../../../../lib/server/backend-proxy";

export async function DELETE(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return admin;

  const parsed = await parseJsonRequest(ctx, adminDeleteRunHistoryRequestSchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  return admin.proxyJson({
    url: `${apiBaseUrl()}${runHistoryPath}`,
    method: "DELETE",
    schema: adminDeleteRunHistoryResponseSchema,
    body: parsed,
  });
}
