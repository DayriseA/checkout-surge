import {
  dashboardRecoveryPath,
  dashboardRecoveryResponseSchema,
  publicVisitorIdHeaderName,
} from "@checkout-surge/contracts";
import { apiBaseUrl, proxyJson } from "../../../lib/server/backend-proxy";
import { resolvePublicVisitorIdentity } from "../../../lib/server/public-visitor";

export async function GET(
  request: Request = new Request("http://localhost/api/dashboard/recovery"),
): Promise<Response> {
  const visitor = resolvePublicVisitorIdentity(request);
  if (visitor instanceof Response) return visitor;
  const response = await proxyJson({
    url: `${apiBaseUrl()}${dashboardRecoveryPath}`,
    method: "GET",
    schema: dashboardRecoveryResponseSchema,
    headers: { [publicVisitorIdHeaderName]: visitor.credential },
  });
  if (visitor.setCookie) response.headers.append("set-cookie", visitor.setCookie);
  return response;
}
