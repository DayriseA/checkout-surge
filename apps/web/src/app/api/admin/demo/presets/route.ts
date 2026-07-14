import {
  adminPresetListPath,
  adminPresetListResponseSchema,
  archiveAdminPresetRequestSchema,
  archiveAdminPresetResponseSchema,
} from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../lib/server/admin-proxy";
import { apiBaseUrl, readJsonRequest, validateJson } from "../../../../lib/server/backend-proxy";

export async function GET(request: Request): Promise<Response> {
  const admin = authorizeAdminProxy(request);
  if (admin instanceof Response) return admin;
  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminPresetListPath}`,
    method: "GET",
    schema: adminPresetListResponseSchema,
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const admin = authorizeAdminProxy(request);
  if (admin instanceof Response) return admin;

  const body = await readJsonRequest(request);
  if (body instanceof Response) return body;

  const parsed = validateJson(body, archiveAdminPresetRequestSchema);
  if (parsed instanceof Response) return parsed;

  return admin.proxyJson({
    url: `${apiBaseUrl()}${adminPresetListPath}`,
    method: "DELETE",
    schema: archiveAdminPresetResponseSchema,
    body: parsed,
  });
}
