import { erpChaosResetPath, erpChaosStatusSchema } from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../lib/server/admin-proxy";
import { createProxyRequestContext, mockErpBaseUrl } from "../../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return admin;
  return admin.proxyJson({
    url: `${mockErpBaseUrl()}${erpChaosResetPath}`,
    method: "POST",
    schema: erpChaosStatusSchema,
  });
}
