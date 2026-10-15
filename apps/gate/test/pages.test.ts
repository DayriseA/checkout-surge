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
    expect(gateLocale(undefined, undefined)).toBe("en");
    expect(gateLocale("checkout-surge-locale=unsupported", undefined)).toBe("en");
    expect(gateLocale("checkout-surge-locale=fr", undefined)).toBe("fr");
  });

  it("follows the browser language until the visitor picks one", () => {
    expect(gateLocale(undefined, "fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr");
    expect(gateLocale("checkout-surge-locale=en", "fr-FR,fr;q=0.9")).toBe("en");
    expect(gateLocale(undefined, "en-GB,en;q=0.9,fr;q=0.8")).toBe("en");
    expect(gateLocale(undefined, "de-DE,fr;q=0.5")).toBe("fr");
    expect(gateLocale(undefined, "de-DE")).toBe("en");
  });
});
