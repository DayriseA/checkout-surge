import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const publicSurface = vi.hoisted(() => ({ id: "public-surface" }));

vi.mock("../src/app/lib/api.js", () => ({
  getPublicDemoSurface: vi.fn(async () => publicSurface),
}));
vi.mock("../src/app/components/public-demo-entry.js", () => ({
  PublicDemoEntry: () =>
    createElement("section", { id: "public-start-controls" }, "Preset and start controls"),
}));
vi.mock("../src/app/lib/server/admin-page-session.js", () => ({
  hasValidAdminPageSession: vi.fn(async () => false),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import DemoDashboardPage from "../src/app/demo/page.js";
import HowItWorksPage from "../src/app/how-it-works/page.js";
import RootLayout from "../src/app/layout.js";
import {
  comparisonFiguresNote,
  formatFigure,
  queueComparison,
  redisComparison,
} from "../src/app/lib/presentation/measured-figures.js";
import { publicNarrative } from "../src/app/lib/presentation/public-vocabulary.js";
import { siteAnchors, sitePages } from "../src/app/lib/site-links.js";
import LimitsPage from "../src/app/limits/page.js";
import HomePage from "../src/app/page.js";
import UnderTheHoodPage from "../src/app/under-the-hood/page.js";

const contentPages = {
  [sitePages.home]: renderToStaticMarkup(createElement(HomePage)),
  [sitePages.howItWorks]: renderToStaticMarkup(createElement(HowItWorksPage)),
  [sitePages.limits]: renderToStaticMarkup(createElement(LimitsPage)),
  [sitePages.underTheHood]: renderToStaticMarkup(createElement(UnderTheHoodPage)),
} as Record<string, string>;

function renderLayout() {
  return RootLayout({ children: createElement("p", null, "content") }).then((layout) =>
    renderToStaticMarkup(layout),
  );
}

describe("public site", () => {
  it("every route of the routes module has a page, and every anchor is on its page", () => {
    for (const route of Object.values(sitePages)) {
      expect(existsSync(new URL(`../src/app${route}/page.tsx`, import.meta.url))).toBe(true);
    }
    for (const [page, anchors] of Object.entries(siteAnchors)) {
      const markup = contentPages[sitePages[page as keyof typeof siteAnchors]] ?? "";
      for (const anchor of Object.values(anchors)) {
        expect(markup, `${page}#${anchor}`).toContain(`id="${anchor}"`);
      }
    }
  });

  it("every in-site link with an anchor, footer included, reaches an element of its page", async () => {
    const sources = { ...contentPages, footer: await renderLayout() };
    for (const [source, markup] of Object.entries(sources)) {
      for (const [, path, anchor] of markup.matchAll(/href="(\/[^"#]*)?#([^"]+)"/g)) {
        const target = path === undefined ? contentPages[source] : contentPages[path];
        if (target === undefined) continue; // Pages rendered from live data, such as /demo.
        expect(target, `${source} links to ${path ?? ""}#${anchor}`).toContain(`id="${anchor}"`);
      }
    }
  });

  it("links the repository only at its root, never to a document inside it", async () => {
    const sources = [...Object.values(contentPages), await renderLayout()];
    for (const markup of sources) {
      for (const [, href] of markup.matchAll(/href="(https:\/\/github\.com[^"]*)"/g)) {
        expect(href).toBe(publicNarrative.repositoryUrl);
      }
    }
  });

  it("introduces the project, quotes both comparisons with their method, and leads to the demo", () => {
    const home = contentPages[sitePages.home] ?? "";
    const hero = home.slice(0, home.indexOf('id="what-goes-wrong"'));

    expect(hero).toContain("<h1");
    expect(hero).toContain("a live demo of the system behind a flash sale");
    expect(hero).toContain('href="/demo"');
    expect(hero).toContain('href="/how-it-works"');
    expect(home.match(/href="\/demo"/g)).toHaveLength(2);
    expect(home).toContain('href="/demo#queue-comparison-title"');
    expect(home).toContain('href="/demo#redis-comparison-title"');
    for (const figure of [queueComparison.everyBuyerAnswered, redisComparison.cold.transactions]) {
      expect(home).toContain(formatFigure(figure.first[0], figure.format));
      expect(home).toContain(formatFigure(figure.second[0], figure.format));
    }
    expect(home).toContain(comparisonFiguresNote);
  });

  it("keeps the overview's technical content on Under the hood and Limits", () => {
    const underTheHood = contentPages[sitePages.underTheHood] ?? "";
    const limits = contentPages[sitePages.limits] ?? "";
    const diagram = underTheHood.slice(
      underTheHood.indexOf("<svg"),
      underTheHood.indexOf("</svg>"),
    );
    const signals = ["Request arrival", "Inventory drain", "Processing backlog"].map((signal) =>
      underTheHood.indexOf(signal),
    );

    expect(diagram).toContain('role="img"');
    expect(diagram.match(/<rect/g)).toHaveLength(7);
    expect(signals.every((index, order) => index > (signals[order - 1] ?? 0))).toBe(true);
    for (const anchor of ["erp", "p95", "vu", "idempotency", "uncertain-result", "drain"]) {
      expect(underTheHood).toContain(`id="${anchor}"`);
    }
    expect(underTheHood).toContain("simulated emails recorded");
    expect(limits).toContain("buyers are simulated by the load generator (k6)");
    expect(limits).toContain("Legacy-ERP delay, capacity, failures, and outages are simulated");
    expect(limits).toContain("not a benchmark");
  });

  it("states the comparisons' disclosures on the detail pages", () => {
    const howItWorks = contentPages[sitePages.howItWorks] ?? "";
    const limits = contentPages[sitePages.limits] ?? "";
    const coLocated =
      "PostgreSQL and Redis run on the API&#x27;s machine. In a real deployment they would sit about a millisecond away";

    expect(howItWorks).toContain(coLocated);
    expect(limits).toContain(coLocated);
    expect(howItWorks).toContain("After 45 seconds");
    expect(howItWorks).toContain("the run with the queue always goes first");
    expect(howItWorks).toContain("the Redis run always goes first");
    expect(howItWorks).toContain("Redis still carries the live counters and the notifications");
    expect(howItWorks).toContain("the same two buy-only API processes serve both");
    expect(howItWorks).toContain("counted for the whole database");
    expect(howItWorks).toContain("each winner costs more work, since two stores must be kept");
  });

  it("keeps the demo page's chooser first and its safety story short, linked to the details", async () => {
    const markup = renderToStaticMarkup(await DemoDashboardPage());
    const capsule = markup.slice(markup.indexOf('id="demo-mental-model"'));

    expect(markup.indexOf('id="public-start-controls"')).toBeLessThan(
      markup.indexOf('id="demo-mental-model"'),
    );
    expect(capsule).toContain("compete for limited stock");
    expect(capsule).toContain('href="/how-it-works"');
    expect(capsule).toContain('href="/limits#scale"');
  });

  it("links the repository safely from the home page and the site's header and footer", async () => {
    for (const markup of [contentPages[sitePages.home] ?? "", await renderLayout()]) {
      expect(markup).toContain(`href="${publicNarrative.repositoryUrl}"`);
      expect(markup).toContain('target="_blank"');
      expect(markup).toContain('rel="noopener noreferrer"');
    }
  });
});
