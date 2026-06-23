import { adminPresetListPath, adminPresetListResponseSchema } from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  controlTokenHeaders,
  proxyJson,
  requireAdminPassphrase,
  requireControlServiceToken,
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
    url: `${apiBaseUrl()}${adminPresetListPath}`,
    method: "GET",
    schema: adminPresetListResponseSchema,
    headers: controlTokenHeaders(token),
  });
}
