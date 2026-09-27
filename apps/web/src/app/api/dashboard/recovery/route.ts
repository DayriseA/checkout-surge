import {
  dashboardProjectionSchema,
  dashboardRecoveryPath,
  dashboardRecoveryQuerySchema,
  publicVisitorIdHeaderName,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  jsonError,
  proxyJson,
} from "../../../lib/server/backend-proxy";
import { resolvePublicVisitorIdentity } from "../../../lib/server/public-visitor";

export async function GET(
  request: Request = new Request("http://localhost/api/dashboard/recovery"),
): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const incomingUrl = new URL(request.url);
  const parsedQuery = dashboardRecoveryQuerySchema.safeParse(
    Object.fromEntries(incomingUrl.searchParams.entries()),
  );
  if (!parsedQuery.success) {
    return jsonError(
      ctx,
      400,
      "invalid_request",
      "Dashboard recovery query did not match the shared contract.",
    );
  }
  const query = parsedQuery.data;
  const upstreamQuery = new URLSearchParams();
  if (query.knownRunId && query.knownSaleOfferId) {
    upstreamQuery.set("knownRunId", query.knownRunId);
    upstreamQuery.set("knownSaleOfferId", query.knownSaleOfferId);
  }
  const visitor = resolvePublicVisitorIdentity(ctx);
  const response = await proxyJson({
    ctx,
    url: `${apiBaseUrl()}${dashboardRecoveryPath}${upstreamQuery.size > 0 ? `?${upstreamQuery}` : ""}`,
    method: "GET",
    schema: dashboardProjectionSchema,
    headers: { [publicVisitorIdHeaderName]: visitor.credential },
  });
  if (visitor.setCookie) response.headers.append("set-cookie", visitor.setCookie);
  return response;
}
