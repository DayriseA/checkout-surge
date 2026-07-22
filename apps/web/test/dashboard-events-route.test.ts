import { dashboardEventsPath } from "@checkout-surge/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/dashboard/events/route.js";
import {
  initializeWebServerConfig,
  resetWebServerConfigForTests,
} from "../src/app/lib/server/config.js";

const originalEnv = { ...process.env };

describe("dashboard events streaming proxy", () => {
  beforeEach(() => {
    initializeWebServerConfig({
      ...process.env,
      ADMIN_DASHBOARD_PASSPHRASE: "admin-passphrase",
      ADMIN_SESSION_SECRET: "admin-session-secret",
      API_BASE_URL: "http://api.internal",
      CONTROL_SERVICE_TOKEN: "control-token",
      PUBLIC_CLIENT_COOKIE_SECRET: "public-client-cookie-secret-32-bytes",
      WEB_ORIGIN: "http://dashboard.local",
    });
  });

  afterEach(() => {
    resetWebServerConfigForTests();
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("passes the private upstream byte stream through with fixed SSE headers", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const request = new Request(`http://dashboard.local${dashboardEventsPath}`);
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(stream, {
          headers: {
            "cache-control": "private",
            "content-type": "application/octet-stream",
            "x-private-upstream": "do-not-forward",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(request);
    const [target, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);

    expect(target).toBe(`http://api.internal${dashboardEventsPath}`);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect([...headers]).toEqual([["accept", "text/event-stream"]]);
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBe(request.signal);
    expect(response.status).toBe(200);
    expect(response.body).toBe(stream);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("x-private-upstream")).toBeNull();
  });

  it("preserves only a non-success upstream status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("private API failure at http://api.internal", {
            status: 429,
            headers: { "retry-after": "private-value" },
          }),
      ),
    );

    const response = await GET(new Request(`http://dashboard.local${dashboardEventsPath}`));

    expect(response.status).toBe(429);
    expect(response.body).toBeNull();
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it.each([
    ["transport failure", () => Promise.reject(new Error("private upstream URL"))],
    ["successful response without a stream", () => Promise.resolve(new Response(null))],
  ])("returns a public-safe 502 for %s", async (_case, upstreamFetch) => {
    vi.stubGlobal("fetch", vi.fn(upstreamFetch));

    const response = await GET(new Request(`http://dashboard.local${dashboardEventsPath}`));

    expect(response.status).toBe(502);
    expect(response.body).toBeNull();
    expect([...response.headers]).toEqual([]);
  });
});
