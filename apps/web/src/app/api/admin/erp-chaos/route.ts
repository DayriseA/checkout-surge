import {
  erpChaosConfigSchema,
  erpChaosStatusPath,
  erpChaosStatusSchema,
} from "@checkout-surge/contracts";
import {
  controlTokenHeaders,
  mockErpBaseUrl,
  proxyJson,
  readJsonRequest,
  requireAdminSession,
  requireControlServiceToken,
  validateJson,
} from "../../../lib/server/backend-proxy";

export async function GET(): Promise<Response> {
  return proxyJson({
    url: `${mockErpBaseUrl()}${erpChaosStatusPath}`,
    method: "GET",
    schema: erpChaosStatusSchema,
  });
}

export async function PUT(request: Request): Promise<Response> {
  const unauthorized = requireAdminSession(request);
  if (unauthorized) {
    return unauthorized;
  }

  const token = requireControlServiceToken();
  if (token instanceof Response) {
    return token;
  }

  const body = await readJsonRequest(request);
  if (body instanceof Response) {
    return body;
  }

  const config = validateJson(body, erpChaosConfigSchema);
  if (config instanceof Response) {
    return config;
  }

  return proxyJson({
    url: `${mockErpBaseUrl()}${erpChaosStatusPath}`,
    method: "PUT",
    schema: erpChaosStatusSchema,
    body: config,
    headers: controlTokenHeaders(token),
  });
}
