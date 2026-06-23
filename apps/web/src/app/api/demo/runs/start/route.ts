import {
  startDemoRunPath,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  proxyJson,
  readJsonRequest,
  validateJson,
} from "../../../../lib/server/backend-proxy";

export async function POST(request: Request) {
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
  });
}
