import {
  comparisonDetailParamsSchema,
  comparisonDetailPath,
  comparisonDetailResponseSchema,
  publicVisitorIdHeaderName,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  jsonError,
  proxyJson,
} from "../../../../lib/server/backend-proxy";
import { resolvePublicVisitorIdentity } from "../../../../lib/server/public-visitor";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ comparisonId?: string }> },
): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const parsed = comparisonDetailParamsSchema.safeParse(await params);
  if (!parsed.success)
    return jsonError(ctx, 400, "invalid_request", "Comparison ID is invalid.", {
      "cache-control": "no-store",
    });
  const visitor = resolvePublicVisitorIdentity(ctx);
  const response = await proxyJson({
    ctx,
    url: `${apiBaseUrl()}${comparisonDetailPath(parsed.data.comparisonId)}`,
    method: "GET",
    schema: comparisonDetailResponseSchema.refine(
      (detail) => detail.comparisonId === parsed.data.comparisonId,
    ),
    headers: { [publicVisitorIdHeaderName]: visitor.credential },
  });
  response.headers.set("cache-control", "no-store");
  if (visitor.setCookie) response.headers.append("set-cookie", visitor.setCookie);
  return response;
}
