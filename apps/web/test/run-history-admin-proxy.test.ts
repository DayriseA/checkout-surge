import { beforeEach, describe, expect, it, vi } from "vitest";

const authorizeAdminProxy = vi.hoisted(() => vi.fn());
const proxyJson = vi.hoisted(() => vi.fn());

vi.mock("../src/app/lib/server/admin-proxy.js", () => ({ authorizeAdminProxy }));
vi.mock("../src/app/lib/server/backend-proxy.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/app/lib/server/backend-proxy.js")>();
  return { ...original, apiBaseUrl: () => "http://api.internal" };
});

import { GET } from "../src/app/api/admin/demo/runs/history/[runId]/route.js";

const runId = "55555555-5555-4555-8555-555555555555";

describe("admin run-history detail proxy", () => {
  beforeEach(() => {
    authorizeAdminProxy.mockReset();
    proxyJson.mockReset();
  });

  it("returns the session authorization failure before proxying", async () => {
    authorizeAdminProxy.mockReturnValue(new Response(null, { status: 401 }));
    const response = await GET(
      new Request(`http://dashboard.local/api/admin/demo/runs/history/${runId}`),
      { params: Promise.resolve({ runId }) },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(proxyJson).not.toHaveBeenCalled();
  });

  it("uses the protected admin API path through the no-store proxy capability", async () => {
    proxyJson.mockResolvedValue(new Response(null, { status: 200 }));
    authorizeAdminProxy.mockReturnValue({ proxyJson });
    const response = await GET(
      new Request(`http://dashboard.local/api/admin/demo/runs/history/${runId}`),
      { params: Promise.resolve({ runId }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(proxyJson).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `http://api.internal/admin/demo/runs/history/${runId}`,
        method: "GET",
      }),
    );
  });

  it("keeps proxied not-found responses no-store", async () => {
    proxyJson.mockResolvedValue(new Response(null, { status: 404 }));
    authorizeAdminProxy.mockReturnValue({ proxyJson });
    const response = await GET(
      new Request(`http://dashboard.local/api/admin/demo/runs/history/${runId}`),
      { params: Promise.resolve({ runId }) },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
