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

import { metadata as aboutMetadata } from "../src/app/about/page.js";
import { metadata as adminMetadata } from "../src/app/admin/page.js";
import { metadata as rootMetadata } from "../src/app/layout.js";
import { metadata as notFoundMetadata } from "../src/app/not-found.js";
import { metadata as demoMetadata } from "../src/app/page.js";
import { metadata as runDetailMetadata } from "../src/app/run-history/[runId]/page.js";
import { metadata as runHistoryMetadata } from "../src/app/run-history/page.js";
import { metadata as watchMetadata } from "../src/app/watch/page.js";

describe("route metadata", () => {
  it("uses the exact Checkout-Surge title template and route titles", () => {
    expect(rootMetadata.title).toEqual({
      template: "%s · Checkout-Surge",
      default: "Checkout-Surge Dashboard",
    });
    expect({
      "/": demoMetadata.title,
      "/watch": watchMetadata.title,
      "/run-history": runHistoryMetadata.title,
      "/run-history/[runId]": runDetailMetadata.title,
      "/about": aboutMetadata.title,
      "/admin": adminMetadata.title,
      "not-found": notFoundMetadata.title,
    }).toEqual({
      "/": { absolute: "Demo · Checkout-Surge" },
      "/watch": "Live watch",
      "/run-history": "Run history",
      "/run-history/[runId]": "Run report",
      "/about": "About",
      "/admin": "Admin",
      "not-found": "Page not found",
    });
  });
});
