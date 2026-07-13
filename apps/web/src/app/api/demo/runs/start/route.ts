import {
  demoRunOperatorModeHeaderName,
  controlServiceTokenHeaderName,
  publicVisitorIdHeaderName,
  startDemoRunPath,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  proxyJson,
  readJsonRequest,
  validateJson,
  requireControlServiceToken,
} from "../../../../lib/server/backend-proxy";
import { resolvePublicVisitorIdentity } from "../../../../lib/server/public-visitor";

export async function POST(request: Request) {
  const body = await readJsonRequest(request);
  if (body instanceof Response) {
    return body;
  }

  const payload = validateJson(body, startDemoRunRequestSchema);
  if (payload instanceof Response) {
    return payload;
  }

  const visitor = resolvePublicVisitorIdentity(request);
  if (visitor instanceof Response) {
    return visitor;
  }
  const controlToken = requireControlServiceToken();
  if (controlToken instanceof Response) return controlToken;

  const response = await proxyJson({
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
