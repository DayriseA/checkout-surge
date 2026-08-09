import {
  erpChaosConfigSchema,
  erpChaosStatusPath,
  erpChaosStatusSchema,
} from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../lib/server/admin-proxy";
import {
  createProxyRequestContext,
  mockErpBaseUrl,
  parseJsonRequest,
  proxyJson,
} from "../../../lib/server/backend-proxy";

export async function GET(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  return proxyJson({
    ctx,
    url: `${mockErpBaseUrl()}${erpChaosStatusPath}`,
    method: "GET",
    schema: erpChaosStatusSchema,
  });
}

export async function PUT(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return admin;

  const config = await parseJsonRequest(ctx, erpChaosConfigSchema);
  if (config instanceof Response) {
    return config;
  }

  return admin.proxyJson({
    url: `${mockErpBaseUrl()}${erpChaosStatusPath}`,
    method: "PUT",
    schema: erpChaosStatusSchema,
    body: config,
  });
}
