import { describe, expect, it } from "vitest";
import type { GatePageState } from "../src/core-status.js";
import { gateLocale, renderGatePage } from "../src/pages.js";

describe("gate language", () => {
  it.each<GatePageState>([
    "stopped",
    "booting",
    "updating",
    "relocating",
    "refreshing",
    "no_capacity",
    "setup_failed",
    "unavailable",
  ])("localizes the %s page", (state) => {
    const english = renderGatePage(state, "/watch");
    const french = renderGatePage(state, "/watch", "fr");
    expect(french).toContain('<html lang="fr">');
    expect(french).toContain('aria-label="Passer en anglais"');
    expect(french.match(/<h1>(.*?)<\/h1>/)?.[1]).not.toBe(english.match(/<h1>(.*?)<\/h1>/)?.[1]);
  });

  it("defaults to English without a supported preference", () => {
    expect(gateLocale(undefined)).toBe("en");
    expect(gateLocale("checkout-surge-locale=unsupported")).toBe("en");
    expect(gateLocale("checkout-surge-locale=fr")).toBe("fr");
  });
});
