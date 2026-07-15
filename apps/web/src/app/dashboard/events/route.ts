import { dashboardEventsPath } from "@checkout-surge/contracts";
import { apiBaseUrl } from "../../lib/server/backend-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const successfulStreamHeaders = {
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "content-type": "text/event-stream; charset=utf-8",
  "x-accel-buffering": "no",
} as const;

export async function GET(request: Request): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}${dashboardEventsPath}`, {
      cache: "no-store",
      headers: { accept: "text/event-stream" },
      signal: request.signal,
    });
  } catch {
    return badGateway();
  }

  if (!upstream.ok) {
    return new Response(null, { status: upstream.status });
  }
  if (!upstream.body) {
    return badGateway();
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: successfulStreamHeaders,
  });
}

function badGateway(): Response {
  return new Response(null, { status: 502 });
}
