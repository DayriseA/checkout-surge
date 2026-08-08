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

import AboutPage from "../src/app/about/page.js";
import RootLayout from "../src/app/layout.js";
import { publicNarrative } from "../src/app/lib/presentation/public-vocabulary.js";
import DemoDashboardPage from "../src/app/page.js";

afterEach(() => {
  sessionMock.mockResolvedValue(false);
});

describe("public visitor mental model", () => {
  it("places the concise causal story and one caveat directly before the start controls", async () => {
    const markup = renderToStaticMarkup(await DemoDashboardPage());
    const capsuleIndex = markup.indexOf('id="demo-mental-model"');
    const controlsIndex = markup.indexOf('id="public-start-controls"');

    expect(capsuleIndex).toBeGreaterThan(-1);
    expect(controlsIndex).toBeGreaterThan(capsuleIndex);
    expect(markup.slice(capsuleIndex, controlsIndex)).toContain(
      "Simulated buyers compete for limited stock",
    );
    expect(markup.slice(capsuleIndex, controlsIndex)).toContain(
      "Redis atomically reserves units immediately without overselling",
    );
    expect(markup.slice(capsuleIndex, controlsIndex)).toContain(
      "every unique reservation reaches a durable outcome",
    );
    expect(markup.slice(capsuleIndex, controlsIndex)).toContain(
      "not universal production evidence",
    );
    expect(markup.slice(capsuleIndex, controlsIndex)).toContain('href="/about"');
    expect(markup.match(/not universal production evidence/g)).toHaveLength(1);
  });

  it("keeps the about narrative in causal order and distinguishes real from simulated", () => {
    const markup = renderToStaticMarkup(createElement(AboutPage));
    const orderedSectionIds = [
      "failure-story",
      "redis-fast-path",
      "queue-protection",
      "real-and-simulated",
      "gold-signals",
      "success",
      "limits-and-source",
    ];
    const sectionPositions = orderedSectionIds.map((id) => markup.indexOf(`id="${id}"`));

    expect(sectionPositions.every((position) => position >= 0)).toBe(true);
    expect(sectionPositions).toEqual([...sectionPositions].sort((left, right) => left - right));

    expect(markup).toContain("A real API, Redis, PostgreSQL, BullMQ queue, and worker runtime");
    expect(markup).toContain("buyers are simulated by the load generator (k6)");
    expect(markup).toContain("Legacy-ERP delay, capacity, failures, and outages are simulated");
    expect(markup).toContain("simulated emails recorded");
    expect(markup).toContain("There is no production external ERP or notification integration");
    expect(markup).toContain(
      "Every unique reservation must first reach a durable confirmed or failed order outcome",
    );
  });

  it("renders four causal signals, an accessible seven-node diagram, and stable glossary anchors", () => {
    const markup = renderToStaticMarkup(createElement(AboutPage));
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
    const aboutMarkup = renderToStaticMarkup(createElement(AboutPage));
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
    expect(publicNarrative.watchOrientation).toContain("durable outcomes");
  });
});
