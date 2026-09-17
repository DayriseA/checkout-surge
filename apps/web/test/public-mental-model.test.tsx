import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const publicSurface = vi.hoisted(() => ({ id: "public-surface" }));
const sessionMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("../src/app/lib/api.js", () => ({
  getPublicDemoSurface: vi.fn(async () => publicSurface),
}));
vi.mock("../src/app/components/public-demo-entry.js", () => ({
  PublicDemoEntry: () =>
    createElement("section", { id: "public-start-controls" }, "Preset and start controls"),
}));
vi.mock("../src/app/lib/server/admin-page-session.js", () => ({
  hasValidAdminPageSession: sessionMock,
}));
vi.mock("../src/app/lib/server/page-view-mode.js", () => ({
  readViewMode: vi.fn(async () => "basic" as const),
}));
vi.mock("../src/app/components/admin-nav.js", () => ({
  AdminSignOut: () => createElement("button", { type: "button" }, "Sign out"),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import AboutPage from "../src/app/about/page.js";
import RootLayout from "../src/app/layout.js";
import { publicNarrative } from "../src/app/lib/presentation/public-vocabulary.js";
import DemoDashboardPage from "../src/app/page.js";

afterEach(() => {
  sessionMock.mockResolvedValue(false);
});

describe("public visitor mental model", () => {
  it("leads with the chooser and keeps the detailed causal story mounted in Advanced", async () => {
    const markup = renderToStaticMarkup(await DemoDashboardPage());
    const capsuleIndex = markup.indexOf('id="demo-mental-model"');
    const controlsIndex = markup.indexOf('id="public-start-controls"');

    expect(capsuleIndex).toBeGreaterThan(-1);
    expect(controlsIndex).toBeLessThan(capsuleIndex);
    expect(markup).toContain(
      "Choose a simulation, start it, and watch a simulated flash sale unfold.",
    );
    const advancedStory = markup.slice(markup.lastIndexOf("data-advanced-only"));
    expect(advancedStory).toContain('hidden=""');
    expect(advancedStory).toContain("Simulated buyers compete for limited stock");
    expect(advancedStory).toContain(
      "Redis atomically reserves units immediately without overselling",
    );
    expect(advancedStory).toContain(
      "every unique reservation reaches a confirmed or failed outcome",
    );
    expect(advancedStory).toContain("not universal production evidence");
    expect(advancedStory).toContain('href="/about"');
    expect(markup.match(/not universal production evidence/g)).toHaveLength(1);
  });

  it("explains the Basic sale flow, failure path, success test, and simulation boundary", async () => {
    const markup = renderToStaticMarkup(await AboutPage());
    const basicSectionIds = [
      "sale-example",
      "reservation-and-confirmation",
      "basic-success",
      "simulation-and-source",
    ];
    const sectionPositions = basicSectionIds.map((id) => markup.indexOf(`id="${id}"`));

    expect(sectionPositions.every((position) => position >= 0)).toBe(true);
    expect(sectionPositions).toEqual([...sectionPositions].sort((left, right) => left - right));
    expect(markup).toContain("100 simulated buyers trying to buy 10 units");
    expect(markup).toContain("Attempts turned away because stock ran out");
    expect(markup).toContain("expected when stock is limited and are not failed orders");
    expect(markup).toContain("Buyers");
    expect(markup).toContain("Reserve stock");
    expect(markup).toContain("Wait for processing");
    expect(markup).toContain("Order outcome");
    expect(markup).toContain("Confirmed or failed");
    expect(markup).toContain(
      "every reservation reached a confirmed or failed outcome, no orders failed or remained pending, nothing was oversold",
    );
    expect(markup).toContain("enough evidence was recorded to verify those facts");
    expect(markup).toContain("Speed and traffic-delivery results are reported separately");
    expect(markup).toContain("buyers and business activity are simulated");
    expect(markup).toContain("no real purchase takes place");
    expect(markup).toContain("Local results depend on the computer");
  });

  it("keeps the architecture, technical narrative, and glossary mounted but hidden in Basic", async () => {
    const markup = renderToStaticMarkup(await AboutPage());
    const advancedMarkup = markup.slice(markup.indexOf('data-advanced-only="true"'));
    const signalSection = markup.slice(
      markup.indexOf('id="gold-signals"'),
      markup.indexOf('id="success"'),
    );
    const diagram = markup.slice(markup.indexOf("<svg"), markup.indexOf("</svg>"));
    const glossaryAnchors = [
      "erp",
      "tps",
      "p95",
      "vu",
      "circuit-breaker",
      "backpressure",
      "idempotency",
      "projection",
      "recovery",
      "drain",
      "reservation-hold",
      "reservation-vs-confirmation",
    ];

    expect(advancedMarkup).toContain('hidden=""');
    expect(advancedMarkup).toContain('id="failure-story"');
    expect(advancedMarkup).toContain('id="redis-fast-path"');
    expect(advancedMarkup).toContain('id="queue-protection"');
    expect(advancedMarkup).toContain('id="real-and-simulated"');
    expect(advancedMarkup).toContain('id="gold-signals"');
    expect(advancedMarkup).toContain('id="success"');
    expect(advancedMarkup).toContain('id="limits-and-source"');
    expect(advancedMarkup).toContain('id="glossary"');
    expect(advancedMarkup).toContain(
      "A real API, Redis, PostgreSQL, BullMQ queue, and worker runtime",
    );
    expect(advancedMarkup).toContain("buyers are simulated by the load generator (k6)");
    expect(advancedMarkup).toContain(
      "Legacy-ERP delay, capacity, failures, and outages are simulated",
    );
    expect(advancedMarkup).toContain("simulated emails recorded");
    expect(signalSection.indexOf("Request arrival")).toBeLessThan(
      signalSection.indexOf("Inventory drain"),
    );
    expect(signalSection.indexOf("Inventory drain")).toBeLessThan(
      signalSection.indexOf("Processing backlog"),
    );
    expect(signalSection.indexOf("Processing backlog")).toBeLessThan(
      signalSection.indexOf("Confirmation convergence"),
    );
    expect(signalSection).toContain(
      "remaining stock falling from the starting amount as reservation quantities are secured",
    );
    expect(signalSection).not.toContain("starting stock falling");
    expect(diagram).toContain('role="img"');
    expect(diagram).toContain('aria-labelledby="architecture-diagram-title');
    expect(markup).toContain("Architecture diagram scrolls sideways.");
    expect(markup).toContain('aria-label="Scrollable architecture diagram"');
    expect(markup).toContain('tabindex="0"');
    expect(diagram.match(/<rect/g)).toHaveLength(7);
    for (const label of [
      "Simulated buyers",
      "API",
      "Redis fast path",
      "BullMQ queue",
      "Worker",
      "Simulated ERP",
      "PostgreSQL",
    ]) {
      expect(diagram).toContain(label);
    }
    for (const anchor of glossaryAnchors) {
      expect(markup).toContain(`id="${anchor}"`);
    }
    expect(markup).toContain(
      "a reusable load-generator worker that runs scenario iterations and may run multiple checkout attempts",
    );
    expect(markup).toContain(
      "confirmation is the later successful order state after queued processing",
    );
    expect(markup).toContain("Failure is a separate durable outcome");
  });

  it("links the repository safely from about and global navigation and supplies B05 copy", async () => {
    const aboutMarkup = renderToStaticMarkup(await AboutPage());
    const layoutMarkup = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "content") }),
    );

    for (const markup of [aboutMarkup, layoutMarkup]) {
      expect(markup).toContain(`href="${publicNarrative.repositoryUrl}"`);
      expect(markup).toContain('target="_blank"');
      expect(markup).toContain('rel="noopener noreferrer"');
    }
    expect(publicNarrative.watchOrientation).toContain(
      "simulated buyers compete for limited stock",
    );
    expect(publicNarrative.watchOrientation).toContain("confirmed or failed");
  });

  it("keeps hash-anchored targets clear of the sticky header via a root scroll offset", async () => {
    const aboutMarkup = renderToStaticMarkup(await AboutPage());
    const layoutMarkup = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "content") }),
    );
    const anchoredSectionIds = [
      "failure-story",
      "redis-fast-path",
      "queue-protection",
      "real-and-simulated",
      "gold-signals",
      "success",
      "limits-and-source",
    ];

    expect(layoutMarkup).toMatch(/<html[^>]*class="[^"]*\bscroll-pt-20\b/);
    for (const sectionId of anchoredSectionIds) {
      expect(aboutMarkup).toContain(`id="${sectionId}"`);
    }
  });
});
