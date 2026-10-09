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
vi.mock("../src/app/components/admin-nav.js", () => ({
  AdminSignOut: () => createElement("button", { type: "button" }, "Sign out"),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import DemoDashboardPage from "../src/app/demo/page.js";
import RootLayout from "../src/app/layout.js";
import { publicNarrative } from "../src/app/lib/presentation/public-vocabulary.js";
import OverviewPage from "../src/app/page.js";

afterEach(() => {
  sessionMock.mockResolvedValue(false);
});

describe("public visitor mental model", () => {
  it("leads with the chooser and keeps the safety story visible", async () => {
    const markup = renderToStaticMarkup(await DemoDashboardPage());
    const capsuleIndex = markup.indexOf('id="demo-mental-model"');
    const controlsIndex = markup.indexOf('id="public-start-controls"');

    expect(capsuleIndex).toBeGreaterThan(-1);
    expect(controlsIndex).toBeGreaterThan(-1);
    expect(controlsIndex).toBeLessThan(capsuleIndex);
    expect(markup).toContain(
      "Choose a simulation, start it, and watch the system handle a release of buyers.",
    );
    const safetyStory = markup.slice(capsuleIndex);
    expect(safetyStory).not.toContain('hidden=""');
    expect(safetyStory).toContain("compete for limited stock");
    expect(safetyStory).toContain("buyers turned away are answered from");
    expect(safetyStory).toContain(
      "every order is confirmed and none failed, and oversold units remain zero",
    );
    expect(safetyStory).toContain("not universal production evidence");
    expect(safetyStory).toContain('href="/#waiting-room"');
    expect(markup.match(/not universal production evidence/g)).toHaveLength(1);
  });

  it("introduces the project and leads visitors to the demo", async () => {
    const markup = renderToStaticMarkup(await OverviewPage());
    const heroMarkup = markup.slice(0, markup.indexOf('id="waiting-room"'));

    expect(heroMarkup).toContain("<h1");
    expect(heroMarkup).toContain("Checkout-Surge");
    expect(heroMarkup).toContain('href="/demo"');
    expect(heroMarkup).toContain('href="#waiting-room"');
    expect(markup.match(/href="\/demo"/g)).toHaveLength(2);
  });

  it("keeps the architecture, technical narrative, and glossary visible", async () => {
    const markup = renderToStaticMarkup(await OverviewPage());
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
      "pending-reservation",
      "reservation-vs-confirmation",
    ];

    expect(markup).not.toContain('hidden=""');
    expect(markup).toContain('id="waiting-room"');
    expect(markup).toContain('id="redis-fast-path"');
    expect(markup).toContain('id="queue-protection"');
    expect(markup).toContain('id="real-and-simulated"');
    expect(markup).toContain('id="gold-signals"');
    expect(markup).toContain('id="success"');
    expect(markup).toContain('id="limits-and-source"');
    expect(markup).toContain('id="glossary"');
    expect(markup).toContain("A real API, Redis, PostgreSQL, BullMQ queue, and worker runtime");
    expect(markup).toContain("buyers are simulated by the load generator (k6)");
    expect(markup.match(/k6/g)).toHaveLength(1);
    expect(markup).toContain("Legacy-ERP delay, capacity, failures, and outages are simulated");
    expect(markup).toContain("simulated emails recorded");
    expect(signalSection.indexOf("Request arrival")).toBeGreaterThan(-1);
    expect(signalSection.indexOf("Inventory drain")).toBeGreaterThan(-1);
    expect(signalSection.indexOf("Processing backlog")).toBeGreaterThan(-1);
    expect(signalSection.indexOf("Confirmation convergence")).toBeGreaterThan(-1);
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
      "Redis decision",
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

  it("links the repository safely from about and global navigation", async () => {
    const aboutMarkup = renderToStaticMarkup(await OverviewPage());
    const layoutMarkup = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "content") }),
    );

    for (const markup of [aboutMarkup, layoutMarkup]) {
      expect(markup).toContain(`href="${publicNarrative.repositoryUrl}"`);
      expect(markup).toContain('target="_blank"');
      expect(markup).toContain('rel="noopener noreferrer"');
    }
  });
});
