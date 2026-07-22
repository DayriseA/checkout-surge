import { errorPayloadSchema } from "@checkout-surge/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProxyJson } from "../src/app/lib/client/proxy-json.js";

afterEach(() => vi.unstubAllGlobals());

describe("readProxyJson degraded reads", () => {
  it.each([
    ["transport", () => Promise.reject(new Error("offline")), "offline"],
    [
      "non-JSON",
      () => Promise.resolve(new Response("not json", { status: 200 })),
      "expected contract",
    ],
  ])("resolves %s failures as unavailable", async (_name, response, reason) => {
    vi.stubGlobal("fetch", vi.fn(response));
    const result = await readProxyJson("/recovery", {
      safeParse: (data) => ({ success: true, data }),
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining(reason),
    });
  });

  it("resolves schema failures as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const result = await readProxyJson("/recovery", {
      safeParse: () => ({ success: false, error: { message: "invalid recovery" } }),
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "Dashboard response did not match the expected contract.",
    });
  });

  it("strictly parses canonical errors and retains safe retry metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(canonicalError("dashboard_recovery_rate_limited", "retry-corr")),
            {
              status: 429,
              headers: { "retry-after": "10" },
            },
          ),
      ),
    );
    const result = await readProxyJson("/recovery", {
      safeParse: (data) => ({ success: true, data }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "Recovery is busy.",
      httpStatus: 429,
      errorCode: "dashboard_recovery_rate_limited",
      correlationId: "retry-corr",
      retryAfterMs: 10_000,
    });
  });

  it("replaces malformed errors and unsafe Retry-After values with safe metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "raw parser details" }), {
            status: 503,
            headers: { "retry-after": "tomorrow" },
          }),
      ),
    );
    const result = await readProxyJson("/recovery", {
      safeParse: (data) => ({ success: true, data }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "Dashboard returned an invalid error response.",
      httpStatus: 503,
    });
  });
});

function canonicalError(code: "dashboard_recovery_rate_limited", correlationId: string) {
  return errorPayloadSchema.parse({
    code,
    message: "Recovery is busy.",
    correlationId,
    timestamp: "2026-06-20T00:00:00.000Z",
  });
}
