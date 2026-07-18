import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/health/route.js";

afterEach(() => vi.unstubAllGlobals());

describe("web health route", () => {
  it("returns cheap local health without fetching a product page or downstream service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ service: "web", status: "ok" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
