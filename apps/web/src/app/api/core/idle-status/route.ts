import { coreIdleStatusPath, coreIdleStatusSchema } from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  proxyJson,
} from "../../../lib/server/backend-proxy";

export function GET(request: Request): Promise<Response> {
  return proxyJson({
    ctx: createProxyRequestContext(request),
    url: `${apiBaseUrl()}${coreIdleStatusPath}`,
    method: "GET",
    schema: coreIdleStatusSchema,
  });
}
