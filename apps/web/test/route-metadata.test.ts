import { describe, expect, it, vi } from "vitest";

vi.mock("../src/app/lib/server/admin-page-session.js", () => ({
  hasValidAdminPageSession: vi.fn(),
}));
vi.mock("../src/app/lib/server/admin-reads.js", () => ({
  readAdminErpChaos: vi.fn(),
  readAdminPresets: vi.fn(),
  readAdminReadiness: vi.fn(),
  readAdminRuntimePolicy: vi.fn(),
}));
vi.mock("../src/app/lib/i18n/server.js", () => ({
  getLocale: vi.fn(async () => "en"),
}));

import { generateMetadata as adminMetadata } from "../src/app/admin/page.js";
import { generateMetadata as demoMetadata } from "../src/app/demo/page.js";
import { generateMetadata as howItWorksMetadata } from "../src/app/how-it-works/page.js";
import { generateMetadata as rootMetadata } from "../src/app/layout.js";
import { getLocale } from "../src/app/lib/i18n/server.js";
import { generateMetadata as limitsMetadata } from "../src/app/limits/page.js";
import { generateMetadata as notFoundMetadata } from "../src/app/not-found.js";
import { generateMetadata as homeMetadata } from "../src/app/page.js";
import { generateMetadata as runDetailMetadata } from "../src/app/run-history/[runId]/page.js";
import { generateMetadata as runHistoryMetadata } from "../src/app/run-history/page.js";
import { generateMetadata as underTheHoodMetadata } from "../src/app/under-the-hood/page.js";
import { generateMetadata as watchMetadata } from "../src/app/watch/page.js";

describe("route metadata", () => {
  it("localizes the public route titles in French", async () => {
    vi.mocked(getLocale).mockResolvedValue("fr");
    try {
      expect((await demoMetadata()).title).toBe("Démo");
      expect((await howItWorksMetadata()).title).toBe("Fonctionnement");
      expect((await limitsMetadata()).title).toBe("Limites et défauts connus");
      expect((await underTheHoodMetadata()).title).toBe("Sous le capot");
      expect((await watchMetadata()).title).toBe("Suivi en direct");
      expect((await runHistoryMetadata()).title).toBe("Historique des simulations");
      expect((await runDetailMetadata()).title).toBe("Rapport de simulation");
      expect((await notFoundMetadata()).title).toBe("Page introuvable");
    } finally {
      vi.mocked(getLocale).mockResolvedValue("en");
    }
  });
  it("uses the exact Checkout-Surge title template and route titles", async () => {
    expect((await rootMetadata()).title).toEqual({
      template: "%s · Checkout-Surge",
      default: "Checkout-Surge Dashboard",
    });
    expect({
      "/": (await homeMetadata()).title,
      "/demo": (await demoMetadata()).title,
      "/how-it-works": (await howItWorksMetadata()).title,
      "/limits": (await limitsMetadata()).title,
      "/under-the-hood": (await underTheHoodMetadata()).title,
      "/watch": (await watchMetadata()).title,
      "/run-history": (await runHistoryMetadata()).title,
      "/run-history/[runId]": (await runDetailMetadata()).title,
      "/admin": (await adminMetadata()).title,
      "not-found": (await notFoundMetadata()).title,
    }).toEqual({
      "/": { absolute: "Checkout-Surge: a live demo of the system behind a flash sale" },
      "/demo": "Demo",
      "/how-it-works": "How it works",
      "/limits": "Limits and known defects",
      "/under-the-hood": "Under the hood",
      "/watch": "Live watch",
      "/run-history": "Run history",
      "/run-history/[runId]": "Run report",
      "/admin": "Admin",
      "not-found": "Page not found",
    });
  });
});
