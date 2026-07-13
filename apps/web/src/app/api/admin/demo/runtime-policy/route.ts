import {
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyResponseSchema,
  adminPublicRuntimePolicyUpdateRequestSchema,
} from "@checkout-surge/contracts";
import { apiBaseUrl, readJsonRequest, validateJson } from "../../../../lib/server/backend-proxy";
import { authorizeAdminProxy } from "../../../../lib/server/admin-proxy";

export async function GET(request: Request): Promise<Response> {
  const admin = authorizeAdminProxy(request);
  if (admin instanceof Response) return admin;
  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminPublicRuntimePolicyPath}`,
    method: "GET",
    schema: adminPublicRuntimePolicyResponseSchema,
  });
}

export async function PUT(request: Request): Promise<Response> {
  const admin = authorizeAdminProxy(request);
  if (admin instanceof Response) return admin;

  const body = await readJsonRequest(request);
  if (body instanceof Response) {
    return body;
  }

  const parsed = validateJson(body, adminPublicRuntimePolicyUpdateRequestSchema);
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
