// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => vi.fn(async () => false));
const viewModeMock = vi.hoisted(() => vi.fn(async () => "basic" as const));
const adminReads = vi.hoisted(() => ({
  erp: vi.fn(async () => ({ status: "available" })),
  presets: vi.fn(async () => ({ status: "available" })),
  policy: vi.fn(async () => ({ status: "available" })),
  readiness: vi.fn(async () => ({ status: "available" })),
}));
const historyRead = vi.hoisted(() => vi.fn());
vi.mock("../src/app/lib/server/admin-page-session.js", () => ({
  hasValidAdminPageSession: sessionMock,
}));
vi.mock("../src/app/lib/server/page-view-mode.js", () => ({
  readViewMode: viewModeMock,
}));
vi.mock("../src/app/lib/server/admin-reads.js", () => ({
  readAdminErpChaos: adminReads.erp,
  readAdminPresets: adminReads.presets,
  readAdminRuntimePolicy: adminReads.policy,
  readAdminReadiness: adminReads.readiness,
}));
vi.mock("../src/app/components/admin/admin-authenticated-surface.js", () => ({
  AdminAuthenticatedSurface: () => createElement("section", null, "Authenticated console data"),
}));
vi.mock("../src/app/lib/api.js", () => ({
  getRunHistoryPage: historyRead,
  pendingDashboardRecovery: () => ({ status: "loading" }),
}));
vi.mock("../src/app/components/run-history-list.js", () => ({
  RunHistoryList: () => createElement("section", null, "Public history list"),
}));
vi.mock("../src/app/components/run-history-admin-controls.js", () => ({
  RunHistoryAdminControls: ({ children }: { children: ReactNode }) =>
    createElement("section", null, "Authenticated history cleanup", children),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: vi.fn() }),
}));

import AdminPage from "../src/app/admin/page.js";
import RootLayout from "../src/app/layout.js";
import RunHistoryPage from "../src/app/run-history/page.js";

beforeEach(() => {
  sessionMock.mockResolvedValue(false);
  viewModeMock.mockResolvedValue("basic");
  historyRead.mockResolvedValue({
    status: "available",
    data: {
      summaries: [],
      page: 1,
      pageSize: 10,
      totalCount: 0,
      timestamp: "2026-06-20T00:00:00.000Z",
    },
  });
});

describe("server-decided admin presentation", () => {
  it("links anonymous users to admin sign-in without exposing sign-out", async () => {
    const markup = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "public content") }),
    );
    expectSkipNavigation(markup);
    expect(markup).toContain("public content");
    expect(markup).toContain('href="/admin"');
    expect(markup).not.toContain("Sign out");
  });

  it("renders admin navigation and sign-out from the first authenticated tree", async () => {
    sessionMock.mockResolvedValue(true);
    const markup = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "operator content") }),
    );
    expectSkipNavigation(markup);
    expect(markup).toContain('href="/admin"');
    expect(markup).toContain("Sign out");
  });

  it("renders one route H1 before the sign-in H2 for an anonymous admin request", async () => {
    const markup = renderToStaticMarkup(await AdminPage());
    const document = parseMarkup(markup);
    const h1s = document.querySelectorAll("h1");
    const h1 = h1s.item(0);
    const h2 = document.querySelector("h2");

    expect(h1s).toHaveLength(1);
    expect(h1?.textContent).toBe("Admin console");
    expect(h2?.textContent).toBe("Protected operator surface");
    if (!h1 || !h2) throw new Error("Expected the admin heading hierarchy.");
    expect(h1.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(markup).toContain("Protected operator surface");
    expect(markup).not.toContain("Reset demo");
  });

  it("performs operator reads and renders the authenticated Admin tree", async () => {
    sessionMock.mockResolvedValue(true);
    const markup = renderToStaticMarkup(await AdminPage());
    const document = parseMarkup(markup);
    const h1s = document.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe("Admin console");
    expect(markup).toContain("Admin console");
    expect(markup).toContain("Authenticated console data");
    expect(markup).not.toContain("Admin passphrase");
    expect(adminReads.erp).toHaveBeenCalledOnce();
    expect(adminReads.presets).toHaveBeenCalledOnce();
    expect(adminReads.policy).toHaveBeenCalledOnce();
    expect(adminReads.readiness).toHaveBeenCalledOnce();
  });

  it("keeps History public while including cleanup only in authenticated server HTML", async () => {
    viewModeMock.mockClear();
    const anonymous = renderToStaticMarkup(
      await RunHistoryPage({ searchParams: Promise.resolve({ page: "1" }) }),
    );
    expect(anonymous).toContain("Public history list");
    expect(anonymous).not.toContain("Authenticated history cleanup");
    expect(anonymous).not.toContain("<legend");

    sessionMock.mockResolvedValue(true);
    const authenticated = renderToStaticMarkup(
      await RunHistoryPage({ searchParams: Promise.resolve({ page: "1" }) }),
    );
    expect(authenticated).toContain("Public history list");
    expect(authenticated).toContain("Authenticated history cleanup");
    expect(authenticated).not.toContain("<legend");
    expect(viewModeMock).not.toHaveBeenCalled();
  });

  it("keeps history diagnostics anonymous-safe while retaining them for authenticated failures", async () => {
    historyRead.mockResolvedValue({
      status: "unavailable",
      errorCode: "backend_unavailable",
      httpStatus: 503,
      correlationId: "history-correlation",
      reason: "history backend diagnostic",
    });

    const anonymous = renderToStaticMarkup(
      await RunHistoryPage({ searchParams: Promise.resolve({ page: "1" }) }),
    );
    expect(anonymous).toContain("The latest information is temporarily unavailable");
    expect(anonymous).not.toContain("Technical details");
    expect(anonymous).not.toContain("history-correlation");
    expect(anonymous).not.toContain("history backend diagnostic");

    sessionMock.mockResolvedValue(true);
    const authenticated = renderToStaticMarkup(
      await RunHistoryPage({ searchParams: Promise.resolve({ page: "1" }) }),
    );
    expect(authenticated).toContain("Technical details");
    expect(authenticated).toContain("history-correlation");
    expect(authenticated).toContain("history backend diagnostic");
  });
});

function expectSkipNavigation(markup: string) {
  const document = parseMarkup(markup);
  const skipLink = document.body.firstElementChild;
  const main = document.querySelector("main");

  expect(skipLink?.tagName).toBe("A");
  expect(skipLink?.textContent).toBe("Skip to main content");
  expect(skipLink?.getAttribute("href")).toBe("#main-content");
  expect(main?.id).toBe("main-content");
  expect(main?.getAttribute("tabindex")).toBe("-1");
}

function parseMarkup(markup: string) {
  return new DOMParser().parseFromString(markup, "text/html");
}
