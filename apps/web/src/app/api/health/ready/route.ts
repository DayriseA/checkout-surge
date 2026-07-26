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
  });
}
