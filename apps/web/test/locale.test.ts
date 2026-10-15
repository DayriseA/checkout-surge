import { describe, expect, it, vi } from "vitest";
import { historyMessages } from "../src/app/lib/i18n/history-messages";
import { localeCookieName, resolveLocale } from "../src/app/lib/i18n/locale";
import { pageMessages } from "../src/app/lib/i18n/page-messages";
import { rootMessages } from "../src/app/lib/i18n/root-messages";
import { getLocale } from "../src/app/lib/i18n/server";
import { signalMessages } from "../src/app/lib/i18n/signal-messages";
import { getTranslation } from "../src/app/lib/i18n/translate";
import {
  formatCount,
  formatDurationMs,
  formatInstantUtc,
} from "../src/app/lib/presentation/format";

const preference = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === localeCookieName && preference.value !== undefined
        ? { value: preference.value }
        : undefined,
  }),
}));

describe("site language", () => {
  it("renders the saved French preference on the server and defaults to English", async () => {
    preference.value = "fr";
    expect(await getLocale()).toBe("fr");
    preference.value = undefined;
    expect(await getLocale()).toBe("en");
    expect(resolveLocale("unsupported")).toBe("en");
  });

  it("keeps translations isolated and interpolates a localized action", () => {
    const en = getTranslation("en");
    const fr = getTranslation("fr");
    expect(fr("Start {name}", { name: "Test" })).toBe("Lancer Test");
    expect(en("Start {name}", { name: "Test" })).toBe("Start Test");
    for (const name of ["My custom preset", "constructor", "toString", "__proto__"]) {
      expect(fr(name)).toBe(name);
    }
  });

  it("defines each French message in exactly one dictionary, so none is silently overridden", () => {
    const keys = [pageMessages, historyMessages, signalMessages, rootMessages].flatMap(Object.keys);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });

  it("formats French counts, durations, and dates while retaining the UTC timezone", () => {
    expect(formatCount(1234.5, "fr")).toBe("1\u202f234,5");
    expect(formatDurationMs(1234, "fr")).toBe("1,2 s");
    expect(formatInstantUtc("2026-10-14T12:34:56Z", { locale: "fr" })).toBe(
      "14/10/2026 12:34:56 UTC",
    );
    expect(formatInstantUtc("2026-10-14T12:34:56Z")).toBe("2026-10-14 12:34:56 UTC");
  });
});
