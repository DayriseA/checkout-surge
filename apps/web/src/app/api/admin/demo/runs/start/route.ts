import {
  startDemoRunPath,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import { apiBaseUrl, readJsonRequest, validateJson } from "../../../../../lib/server/backend-proxy";
import { authorizeAdminProxy } from "../../../../../lib/server/admin-proxy";

export async function POST(request: Request): Promise<Response> {
  const admin = authorizeAdminProxy(request, { operatorMode: "admin" });
  if (admin instanceof Response) return admin;

  const body = await readJsonRequest(request);
  if (body instanceof Response) {
    return body;
  }

  const payload = validateJson(body, startDemoRunRequestSchema);
  if (payload instanceof Response) {
    return payload;
  }

  return admin.proxyJson({
    url: `${apiBaseUrl()}${startDemoRunPath}`,
    method: "POST",
    schema: startDemoRunResponseSchema,
    body: payload,
  });
}
