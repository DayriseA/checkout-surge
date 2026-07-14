import {
  adminPresetMutationResponseSchema,
  adminPresetSavePath,
  saveDemoPresetRequestSchema,
} from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../../lib/server/admin-proxy";
import {
  apiBaseUrl,
  createProxyRequestContext,
  readJsonRequest,
  validateJson,
} from "../../../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return admin;

  const body = await readJsonRequest(ctx);
  if (body instanceof Response) {
    return body;
  }

  const parsed = validateJson(ctx, body, saveDemoPresetRequestSchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminPresetSavePath}`,
    method: "POST",
    schema: adminPresetMutationResponseSchema,
    body: parsed,
  });
}
