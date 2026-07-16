import {
  adminRunHistoryDetailPath,
  adminRunHistoryDetailResponseSchema,
  runHistoryDetailParamsSchema,
} from "@checkout-surge/contracts";
import { authorizeAdminProxy } from "../../../../../../lib/server/admin-proxy";
import {
  apiBaseUrl,
  createProxyRequestContext,
  jsonError,
} from "../../../../../../lib/server/backend-proxy";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId?: string }> },
): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const admin = authorizeAdminProxy(ctx);
  if (admin instanceof Response) return noStore(admin);
  const parsed = runHistoryDetailParamsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return noStore(jsonError(ctx, 400, "invalid_request", "Run ID must be a valid UUID."));
  }
  return noStore(
    await admin.proxyJson({
      url: `${apiBaseUrl()}${adminRunHistoryDetailPath(parsed.data.runId)}`,
      method: "GET",
      schema: adminRunHistoryDetailResponseSchema,
    }),
  );
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
