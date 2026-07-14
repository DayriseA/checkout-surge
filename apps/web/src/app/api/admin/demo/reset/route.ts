import { adminDemoResetPath, adminDemoResetResponseSchema } from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../lib/server/admin-proxy";
import { apiBaseUrl, createProxyRequestContext } from "../../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return admin;
  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminDemoResetPath}`,
    method: "POST",
    schema: adminDemoResetResponseSchema,
  });
}
