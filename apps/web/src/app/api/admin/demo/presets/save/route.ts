import {
  adminPresetMutationResponseSchema,
  adminPresetSavePath,
  saveDemoPresetRequestSchema,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  controlTokenHeaders,
  proxyJson,
  readJsonRequest,
  requireAdminPassphrase,
  requireControlServiceToken,
  validateJson,
} from "../../../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
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

  const parsed = validateJson(body, saveDemoPresetRequestSchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  return proxyJson({
    url: `${apiBaseUrl()}${adminPresetSavePath}`,
    method: "POST",
    schema: adminPresetMutationResponseSchema,
    headers: controlTokenHeaders(token),
    body: parsed,
  });
}
