import { erpChaosResetPath, erpChaosStatusSchema } from "@checkout-surge/contracts";
import {
  controlTokenHeaders,
  mockErpBaseUrl,
  proxyJson,
  requireAdminPassphrase,
  requireControlServiceToken,
} from "../../../../lib/server/backend-proxy.js";

export async function POST(request: Request): Promise<Response> {
  const unauthorized = requireAdminPassphrase(request);
  if (unauthorized) {
    return unauthorized;
  }

  const token = requireControlServiceToken();
  if (token instanceof Response) {
    return token;
  }

  return proxyJson({
    url: `${mockErpBaseUrl()}${erpChaosResetPath}`,
    method: "POST",
    schema: erpChaosStatusSchema,
    headers: controlTokenHeaders(token),
  });
}
