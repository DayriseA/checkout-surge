import {
  demoRunOperatorModeHeaderName,
  startDemoRunPath,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  controlTokenHeaders,
  proxyJson,
  readJsonRequest,
  requireAdminSession,
  requireControlServiceToken,
  validateJson,
} from "../../../../../lib/server/backend-proxy";

export async function POST(request: Request): Promise<Response> {
  const unauthorized = requireAdminSession(request);
  if (unauthorized) {
    return unauthorized;
  }

  const token = requireControlServiceToken();
  if (token instanceof Response) {
    return token;
  }

  const body = await readJsonRequest(request);
  if (body instanceof Response) {
    return body;
  }

  const payload = validateJson(body, startDemoRunRequestSchema);
  if (payload instanceof Response) {
    return payload;
  }

  return proxyJson({
    url: `${apiBaseUrl()}${startDemoRunPath}`,
    method: "POST",
    schema: startDemoRunResponseSchema,
    body: payload,
    headers: {
      ...controlTokenHeaders(token),
      [demoRunOperatorModeHeaderName]: "admin",
    },
  });
}
