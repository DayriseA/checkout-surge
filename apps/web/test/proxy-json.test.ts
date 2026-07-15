import { afterEach, describe, expect, it, vi } from "vitest";
import { readProxyJson } from "../src/app/lib/client/proxy-json.js";

afterEach(() => vi.unstubAllGlobals());

describe("readProxyJson degraded reads", () => {
  it.each([
    ["transport", () => Promise.reject(new Error("offline")), "offline"],
    ["unexpected HTTP", () => Promise.resolve(new Response(JSON.stringify({ message: "down" }), { status: 503 })), "down"],
    ["non-JSON", () => Promise.resolve(new Response("not json", { status: 200 })), "Unexpected token"],
  ])("resolves %s failures as unavailable", async (_name, response, reason) => {
    vi.stubGlobal("fetch", vi.fn(response));
    const result = await readProxyJson("/recovery", { safeParse: (data) => ({ success: true, data }) });
    expect(result).toMatchObject({ status: "unavailable", reason: expect.stringContaining(reason) });
  });

  it("resolves schema failures as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const result = await readProxyJson("/recovery", {
      safeParse: () => ({ success: false, error: { message: "invalid recovery" } }),
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "Dashboard response did not match the shared contract: invalid recovery",
    });
  });
});
