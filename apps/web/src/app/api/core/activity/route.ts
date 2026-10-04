import { coreActivityPath, coreIdleStatusSchema } from "@checkout-surge/contracts";
import {
  apiBaseUrl,
  createProxyRequestContext,
  proxyJson,
} from "../../../lib/server/backend-proxy";

/** The "stay awake" action. */
export function POST(request: Request): Promise<Response> {
  return proxyJson({
    ctx: createProxyRequestContext(request),
    url: `${apiBaseUrl()}${coreActivityPath}`,
    method: "POST",
    schema: coreIdleStatusSchema,
  });
}
