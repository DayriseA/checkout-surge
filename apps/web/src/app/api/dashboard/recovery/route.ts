import { dashboardRecoveryPath, dashboardRecoveryResponseSchema } from "@checkout-surge/contracts";
import { apiBaseUrl, proxyJson } from "../../../lib/server/backend-proxy.js";

export async function GET(): Promise<Response> {
  return proxyJson({
    url: `${apiBaseUrl()}${dashboardRecoveryPath}`,
    method: "GET",
    schema: dashboardRecoveryResponseSchema,
  });
}
