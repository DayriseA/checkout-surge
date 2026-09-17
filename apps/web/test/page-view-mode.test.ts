import { afterEach, describe, expect, it, vi } from "vitest";

const cookieJar = vi.hoisted(() => ({
  value: undefined as string | undefined,
  legacyValue: undefined as string | undefined,
  failing: false,
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => {
    if (cookieJar.failing) {
      throw new Error("cookies was called outside a request scope");
    }
    return {
      get: (name: string) => {
        if (name === "checkout-surge.view" && cookieJar.value !== undefined) {
          return { name, value: cookieJar.value };
        }
        if (name === "checkout-surge.view.watch" && cookieJar.legacyValue !== undefined) {
          return { name, value: cookieJar.legacyValue };
        }
        return undefined;
      },
    };
  }),
}));

import { readViewMode } from "../src/app/lib/server/page-view-mode.js";

afterEach(() => {
  cookieJar.value = undefined;
  cookieJar.legacyValue = undefined;
  cookieJar.failing = false;
});

describe("readViewMode", () => {
  it.each([
    ["advanced", "advanced"],
    [undefined, "basic"],
    ["ADVANCED", "basic"],
    ["true", "basic"],
  ] as const)("reads cookie value %s as %s", async (stored, expected) => {
    cookieJar.value = stored;
    await expect(readViewMode()).resolves.toBe(expected);
  });

  it("falls back to basic when the cookie store cannot be read", async () => {
    cookieJar.failing = true;
    await expect(readViewMode()).resolves.toBe("basic");
  });

  it("ignores legacy page-specific cookies", async () => {
    cookieJar.legacyValue = "advanced";
    await expect(readViewMode()).resolves.toBe("basic");
  });
});
