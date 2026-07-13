import { adminPresetListPath, adminPresetListResponseSchema } from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../lib/server/admin-proxy";
import { apiBaseUrl } from "../../../../lib/server/backend-proxy";

export async function GET(request: Request): Promise<Response> {
  const admin = authorizeAdminProxy(request);
  if (admin instanceof Response) return admin;
  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminPresetListPath}`,
    method: "GET",
    schema: adminPresetListResponseSchema,
  });
}
