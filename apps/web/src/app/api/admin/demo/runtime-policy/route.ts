import {
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyResponseSchema,
  adminPublicRuntimePolicyUpdateRequestSchema,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  controlTokenHeaders,
  proxyJson,
  readJsonRequest,
  requireAdminPassphrase,
  requireControlServiceToken,
  validateJson,
} from "../../../../lib/server/backend-proxy";

export async function GET(request: Request): Promise<Response> {
  const unauthorized = requireAdminPassphrase(request);
  if (unauthorized) {
    return unauthorized;
  }

  const token = requireControlServiceToken();
  if (token instanceof Response) {
    return token;
  }

  return proxyJson({
    url: `${apiBaseUrl()}${adminPublicRuntimePolicyPath}`,
    method: "GET",
    schema: adminPublicRuntimePolicyResponseSchema,
    headers: controlTokenHeaders(token),
  });
}

export async function PUT(request: Request): Promise<Response> {
  const unauthorized = requireAdminPassphrase(request);
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

  const parsed = validateJson(body, adminPublicRuntimePolicyUpdateRequestSchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  return proxyJson({
    url: `${apiBaseUrl()}${adminPublicRuntimePolicyPath}`,
    method: "PUT",
    schema: adminPublicRuntimePolicyResponseSchema,
    headers: controlTokenHeaders(token),
    body: parsed,
  });
}
