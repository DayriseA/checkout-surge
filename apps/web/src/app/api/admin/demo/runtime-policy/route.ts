import {
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyResponseSchema,
  adminPublicRuntimePolicyUpdateRequestSchema,
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
    url: `${apiBaseUrl()}${adminPublicRuntimePolicyPath}`,
    method: "GET",
    schema: adminPublicRuntimePolicyResponseSchema,
  });
}

export async function PUT(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return admin;

  const parsed = await parseJsonRequest(ctx, adminPublicRuntimePolicyUpdateRequestSchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminPublicRuntimePolicyPath}`,
    method: "PUT",
    schema: adminPublicRuntimePolicyResponseSchema,
    body: parsed,
  });
}
