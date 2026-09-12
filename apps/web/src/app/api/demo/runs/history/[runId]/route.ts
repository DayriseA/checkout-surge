import {
  publicRunHistoryDetailResponseSchema,
  runHistoryDetailParamsSchema,
  runHistoryDetailPath,
} from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  jsonError,
  proxyJson,
} from "../../../../../lib/server/backend-proxy";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId?: string }> },
): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  const parsed = runHistoryDetailParamsSchema.safeParse(await params);
  if (!parsed.success) {
    return jsonError(ctx, 400, "invalid_request", "Run history detail ID is invalid.");
  }
  return proxyJson({
    ctx,
    url: `${apiBaseUrl()}${runHistoryDetailPath(parsed.data.runId)}`,
    method: "GET",
    schema: publicRunHistoryDetailResponseSchema.refine(
      ({ run, summary }) => run.runId === parsed.data.runId && summary.runId === parsed.data.runId,
    ),
  });
}
