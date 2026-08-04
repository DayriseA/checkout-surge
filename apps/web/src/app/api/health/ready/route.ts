import { healthReadyPath, healthResponseSchema } from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  proxyJson,
} from "../../../lib/server/backend-proxy";

export function GET(
  request: Request = new Request("http://localhost/api/health/ready"),
): Promise<Response> {
  const ctx = createProxyRequestContext(request);
  return proxyJson({
    acceptedContractStatuses: [503],
    ctx,
    url: `${apiBaseUrl()}${healthReadyPath}`,
    method: "GET",
    schema: healthResponseSchema,
  }).then((response) => sanitizePublicReadiness(response));
}

async function sanitizePublicReadiness(response: Response): Promise<Response> {
  if (response.status !== 200 && response.status !== 503) return response;

  try {
    const parsed = healthResponseSchema.safeParse(await response.clone().json());
    if (!parsed.success) return response;

    const headers = new Headers(response.headers);
    return Response.json({ ...parsed.data, checks: [] }, { status: response.status, headers });
  } catch {
    return response;
  }
}
