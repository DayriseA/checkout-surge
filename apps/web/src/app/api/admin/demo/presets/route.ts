import {
  adminPresetListPath,
  adminPresetListResponseSchema,
  archiveAdminPresetRequestSchema,
  archiveAdminPresetResponseSchema,
} from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../lib/server/admin-proxy";
import {
  apiBaseUrl,
  createProxyRequestContext,
  parseJsonRequest,
} from "../../../../lib/server/backend-proxy";

export async function GET(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return admin;
  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminPresetListPath}`,
    method: "GET",
    schema: adminPresetListResponseSchema,
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return admin;

  const parsed = await parseJsonRequest(ctx, archiveAdminPresetRequestSchema);
  if (parsed instanceof Response) return parsed;

  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminPresetListPath}`,
    method: "DELETE",
    schema: archiveAdminPresetResponseSchema,
    body: parsed,
  });
}
