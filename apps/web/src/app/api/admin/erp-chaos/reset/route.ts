import { erpChaosResetPath, erpChaosStatusSchema } from "@checkout-surge/contracts";
import {
  controlTokenHeaders,
  mockErpBaseUrl,
  proxyJson,
  requireAdminSession,
  requireControlServiceToken,
} from "../../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
  const unauthorized = requireAdminSession(request);
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
