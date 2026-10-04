import { type NextFetchEvent, NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../src/proxy";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function proxyRequest(path: string) {
  const pending: Promise<unknown>[] = [];
  const event = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
  proxy(new NextRequest(`http://localhost:3000${path}`), event as unknown as NextFetchEvent);
  await Promise.all(pending);
}

describe("core activity proxy", () => {
  it("reports visitor requests to the API as core activity", async () => {
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:4000/");
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await proxyRequest("/");
    await proxyRequest("/api/demo/runs/start");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4000/core/activity", {
      method: "POST",
    });
  });

  it.each([
    "/health",
    "/api/health/ready",
    "/api/core/idle-status",
    "/api/dashboard/recovery",
    "/dashboard/events",
  ])("does not count %s", async (path) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await proxyRequest(path);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never fails the request when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(proxyRequest("/demo")).resolves.toBeUndefined();
  });
});
