import { coreActivityPath } from "@checkout-surge/contracts";
import type { NextFetchEvent, NextRequest } from "next/server";
import {
  coreIdleStatusProxyPath,
  dashboardRecoveryProxyPath,
  healthReadyProxyPath,
} from "./app/lib/control-paths";

/**
 * Health checks, background polling and the live stream never keep the core awake. Every other
 * request is visitor activity.
 */
const uncountedPaths = new Set<string>([
  "/health",
  healthReadyProxyPath,
  coreIdleStatusProxyPath,
  dashboardRecoveryProxyPath,
  "/dashboard/events",
]);

/**
 * Reports each counted request to the API, which owns the core's idle deadline. Reporting is best
 * effort and never delays the request. Proxy runs apart from the app, so it reads its environment
 * directly instead of the web server configuration.
 */
export function proxy(request: NextRequest, event: NextFetchEvent): void {
  if (uncountedPaths.has(request.nextUrl.pathname)) return;
  event.waitUntil(reportActivity());
}

async function reportActivity(): Promise<void> {
  try {
    const apiBaseUrl = (process.env.API_BASE_URL?.trim() || "http://localhost:4000").replace(
      /\/+$/,
      "",
    );
    const response = await fetch(`${apiBaseUrl}${coreActivityPath}`, { method: "POST" });
    await response.body?.cancel();
  } catch {
    // A missed report only shortens the countdown; the visitor can still press "stay awake".
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
