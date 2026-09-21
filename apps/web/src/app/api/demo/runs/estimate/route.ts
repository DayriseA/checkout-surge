import {
  controlServiceTokenHeaderName,
  demoRunOperatorModeHeaderName,
  previewDemoRunPath,
  previewDemoRunRequestSchema,
  previewDemoRunResponseSchema,
  publicVisitorIdHeaderName,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  parseJsonRequest,
  proxyJson,
  requireControlServiceToken,
} from "../../../../lib/server/backend-proxy";
import { resolvePublicVisitorIdentity } from "../../../../lib/server/public-visitor";

export async function POST(request: Request) {
  const ctx = createProxyRequestContext(request);
  const payload = await parseJsonRequest(ctx, previewDemoRunRequestSchema);
  if (payload instanceof Response) {
    return payload;
  }

  const visitor = resolvePublicVisitorIdentity(ctx);
  if (visitor instanceof Response) {
    return visitor;
  }
  const controlToken = requireControlServiceToken(ctx);
  if (controlToken instanceof Response) return controlToken;

  const response = await proxyJson({
    ctx,
    url: `${apiBaseUrl()}${previewDemoRunPath}`,
    method: "POST",
    schema: previewDemoRunResponseSchema,
    body: payload,
    headers: {
      [demoRunOperatorModeHeaderName]: "public",
      [publicVisitorIdHeaderName]: visitor.credential,
      [controlServiceTokenHeaderName]: controlToken,
    },
  });
  if (visitor.setCookie) {
    response.headers.append("set-cookie", visitor.setCookie);
  }
  return response;
}
