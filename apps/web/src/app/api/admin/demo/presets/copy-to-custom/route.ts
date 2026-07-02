import {
  adminPresetCopyToCustomPath,
  adminPresetMutationResponseSchema,
  copyDemoPresetToCustomRequestSchema,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  controlTokenHeaders,
  proxyJson,
  readJsonRequest,
  requireAdminSession,
  requireControlServiceToken,
  validateJson,
} from "../../../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
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

  const parsed = validateJson(body, copyDemoPresetToCustomRequestSchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  return proxyJson({
    url: `${apiBaseUrl()}${adminPresetCopyToCustomPath}`,
    method: "POST",
    schema: adminPresetMutationResponseSchema,
    headers: controlTokenHeaders(token),
    body: parsed,
  });
}
