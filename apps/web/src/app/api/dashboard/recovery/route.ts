import {
  dashboardRecoveryPath,
  dashboardRecoveryResponseSchema,
  publicVisitorIdHeaderName,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  proxyJson,
} from "../../../lib/server/backend-proxy";
import { resolvePublicVisitorIdentity } from "../../../lib/server/public-visitor";

export async function GET(
  request: Request = new Request("http://localhost/api/dashboard/recovery"),
): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const visitor = resolvePublicVisitorIdentity(ctx);
  if (visitor instanceof Response) return visitor;
  const response = await proxyJson({
    ctx,
    url: `${apiBaseUrl()}${dashboardRecoveryPath}`,
    method: "GET",
    schema: dashboardRecoveryResponseSchema,
    headers: { [publicVisitorIdHeaderName]: visitor.credential },
  });
  if (visitor.setCookie) response.headers.append("set-cookie", visitor.setCookie);
  return response;
}
