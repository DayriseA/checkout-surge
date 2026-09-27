import {
  controlServiceTokenHeaderName,
  demoRunOperatorModeHeaderName,
  publicVisitorIdHeaderName,
  startDemoRunPath,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  parseJsonRequest,
  proxyJson,
} from "../../../../lib/server/backend-proxy";
import { webServerConfig } from "../../../../lib/server/config";
import { resolvePublicVisitorIdentity } from "../../../../lib/server/public-visitor";

export async function POST(request: Request) {
  const ctx = createProxyRequestContext(request);
  const payload = await parseJsonRequest(ctx, startDemoRunRequestSchema);
  if (payload instanceof Response) {
    return payload;
  }

  const visitor = resolvePublicVisitorIdentity(ctx);

  const response = await proxyJson({
    ctx,
    url: `${apiBaseUrl()}${startDemoRunPath}`,
    method: "POST",
    schema: startDemoRunResponseSchema,
    body: payload,
    headers: {
      [demoRunOperatorModeHeaderName]: "public",
      [publicVisitorIdHeaderName]: visitor.credential,
      [controlServiceTokenHeaderName]: webServerConfig().controlServiceToken,
    },
  });
  if (visitor.setCookie) {
    response.headers.append("set-cookie", visitor.setCookie);
  }
  return response;
}
