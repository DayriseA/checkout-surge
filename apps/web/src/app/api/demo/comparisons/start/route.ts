import {
  controlServiceTokenHeaderName,
  demoRunOperatorModeHeaderName,
  publicVisitorIdHeaderName,
  startComparisonPath,
  startComparisonRequestSchema,
  startComparisonResponseSchema,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  parseJsonRequest,
  proxyJson,
} from "../../../../lib/server/backend-proxy";
import { webServerConfig } from "../../../../lib/server/config";
import { resolvePublicVisitorIdentity } from "../../../../lib/server/public-visitor";

export async function POST(request: Request): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const payload = await parseJsonRequest(ctx, startComparisonRequestSchema);
  if (payload instanceof Response) {
    payload.headers.set("cache-control", "no-store");
    return payload;
  }
  const visitor = resolvePublicVisitorIdentity(ctx);
  const response = await proxyJson({
    ctx,
    url: `${apiBaseUrl()}${startComparisonPath}`,
    method: "POST",
    schema: startComparisonResponseSchema,
    body: payload,
    headers: {
      [demoRunOperatorModeHeaderName]: "public",
      [publicVisitorIdHeaderName]: visitor.credential,
      [controlServiceTokenHeaderName]: webServerConfig().controlServiceToken,
    },
  });
  response.headers.set("cache-control", "no-store");
  if (visitor.setCookie) response.headers.append("set-cookie", visitor.setCookie);
  return response;
}
