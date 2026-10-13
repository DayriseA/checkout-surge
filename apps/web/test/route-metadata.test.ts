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

import { metadata as adminMetadata } from "../src/app/admin/page.js";
import { metadata as demoMetadata } from "../src/app/demo/page.js";
import { metadata as howItWorksMetadata } from "../src/app/how-it-works/page.js";
import { metadata as rootMetadata } from "../src/app/layout.js";
import { metadata as limitsMetadata } from "../src/app/limits/page.js";
import { metadata as notFoundMetadata } from "../src/app/not-found.js";
import { metadata as homeMetadata } from "../src/app/page.js";
import { metadata as runDetailMetadata } from "../src/app/run-history/[runId]/page.js";
import { metadata as runHistoryMetadata } from "../src/app/run-history/page.js";
import { metadata as underTheHoodMetadata } from "../src/app/under-the-hood/page.js";
import { metadata as watchMetadata } from "../src/app/watch/page.js";

describe("route metadata", () => {
  it("uses the exact Checkout-Surge title template and route titles", () => {
    expect(rootMetadata.title).toEqual({
      template: "%s · Checkout-Surge",
      default: "Checkout-Surge Dashboard",
    });
    expect({
      "/": homeMetadata.title,
      "/demo": demoMetadata.title,
      "/how-it-works": howItWorksMetadata.title,
      "/limits": limitsMetadata.title,
      "/under-the-hood": underTheHoodMetadata.title,
      "/watch": watchMetadata.title,
      "/run-history": runHistoryMetadata.title,
      "/run-history/[runId]": runDetailMetadata.title,
      "/admin": adminMetadata.title,
      "not-found": notFoundMetadata.title,
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
