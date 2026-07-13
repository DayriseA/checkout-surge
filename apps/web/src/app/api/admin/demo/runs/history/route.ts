import {
  adminDeleteRunHistoryRequestSchema,
  adminDeleteRunHistoryResponseSchema,
  runHistoryPath,
} from "@checkout-surge/contracts";
import { apiBaseUrl, readJsonRequest, validateJson } from "../../../../../lib/server/backend-proxy";
import { authorizeAdminProxy } from "../../../../../lib/server/admin-proxy";

export async function DELETE(request: Request): Promise<Response> {
  const admin = authorizeAdminProxy(request);
  if (admin instanceof Response) return admin;

  const body = await readJsonRequest(request);
  if (body instanceof Response) {
    return body;
  }

  const parsed = validateJson(body, adminDeleteRunHistoryRequestSchema);
  if (parsed instanceof Response) {
    return parsed;
  }

  return admin.proxyJson({
    url: `${apiBaseUrl()}${runHistoryPath}`,
    method: "DELETE",
    schema: adminDeleteRunHistoryResponseSchema,
    body: parsed,
  });
}
