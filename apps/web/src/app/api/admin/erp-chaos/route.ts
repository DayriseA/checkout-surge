import {
  erpChaosConfigSchema,
  erpChaosStatusPath,
  erpChaosStatusSchema,
} from "@checkout-surge/contracts";
import {
  mockErpBaseUrl,
  proxyJson,
  readJsonRequest,
  validateJson,
} from "../../../lib/server/backend-proxy";
import { authorizeAdminProxy } from "../../../lib/server/admin-proxy";

export async function GET(): Promise<Response> {
  return proxyJson({
    url: `${mockErpBaseUrl()}${erpChaosStatusPath}`,
    method: "GET",
    schema: erpChaosStatusSchema,
  });
}

export async function PUT(request: Request): Promise<Response> {
  const admin = authorizeAdminProxy(request);
  if (admin instanceof Response) return admin;

  const body = await readJsonRequest(request);
  if (body instanceof Response) {
    return body;
  }

  const config = validateJson(body, erpChaosConfigSchema);
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
