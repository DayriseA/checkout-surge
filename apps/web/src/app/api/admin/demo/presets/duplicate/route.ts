import {
  adminPresetDuplicatePath,
  adminPresetMutationResponseSchema,
  duplicateDemoPresetRequestSchema,
} from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../../lib/server/admin-proxy";
import {
  apiBaseUrl,
  createProxyRequestContext,
  parseJsonRequest,
} from "../../../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return admin;

  const parsed = await parseJsonRequest(ctx, duplicateDemoPresetRequestSchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminPresetDuplicatePath}`,
    method: "POST",
    schema: adminPresetMutationResponseSchema,
    body: parsed,
  });
}
