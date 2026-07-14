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
  proxyJson,
  readJsonRequest,
  requireControlServiceToken,
  validateJson,
} from "../../../../lib/server/backend-proxy";
import { resolvePublicVisitorIdentity } from "../../../../lib/server/public-visitor";

export async function POST(request: Request) {
  const ctx = createProxyRequestContext(request);
  const body = await readJsonRequest(ctx);
  if (body instanceof Response) {
    return body;
  }

  const payload = validateJson(ctx, body, startDemoRunRequestSchema);
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
    url: `${apiBaseUrl()}${startDemoRunPath}`,
    method: "POST",
    schema: startDemoRunResponseSchema,
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
