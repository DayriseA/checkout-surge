import { afterEach, describe, expect, it, vi } from "vitest";

const cookieJar = vi.hoisted(() => ({
  value: undefined as string | undefined,
  failing: false,
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => {
    if (cookieJar.failing) {
      throw new Error("cookies was called outside a request scope");
    }
    return {
      get: (name: string) =>
        name === "checkout-surge.view.watch" && cookieJar.value !== undefined
          ? { name, value: cookieJar.value }
          : undefined,
    };
  }),
}));

import { readPageViewMode } from "../src/app/lib/server/page-view-mode.js";

afterEach(() => {
  cookieJar.value = undefined;
  cookieJar.failing = false;
});

describe("readPageViewMode", () => {
  it.each([
    ["advanced", "advanced"],
    [undefined, "basic"],
    ["ADVANCED", "basic"],
    ["true", "basic"],
  ] as const)("reads cookie value %s as %s", async (stored, expected) => {
    cookieJar.value = stored;
    await expect(readPageViewMode("watch")).resolves.toBe(expected);
  });

  it("falls back to basic when the cookie store cannot be read", async () => {
    cookieJar.failing = true;
    await expect(readPageViewMode("watch")).resolves.toBe("basic");
  });
});
