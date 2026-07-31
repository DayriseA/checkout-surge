import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => vi.fn(async () => false));
const adminReads = vi.hoisted(() => ({
  erp: vi.fn(async () => ({ status: "available" })),
  presets: vi.fn(async () => ({ status: "available" })),
  policy: vi.fn(async () => ({ status: "available" })),
}));
const historyRead = vi.hoisted(() => vi.fn());
vi.mock("../src/app/lib/server/admin-page-session.js", () => ({
  hasValidAdminPageSession: sessionMock,
}));
vi.mock("../src/app/lib/server/admin-reads.js", () => ({
  readAdminErpChaos: adminReads.erp,
  readAdminPresets: adminReads.presets,
  readAdminRuntimePolicy: adminReads.policy,
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import AdminPage from "../src/app/admin/page.js";
import RootLayout from "../src/app/layout.js";
import RunHistoryPage from "../src/app/run-history/page.js";

beforeEach(() => {
  sessionMock.mockResolvedValue(false);
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
    expect(markup).toContain("public content");
    expect(markup).toContain('href="/admin"');
    expect(markup).not.toContain("Sign out");
  });

  it("renders admin navigation and sign-out from the first authenticated tree", async () => {
    sessionMock.mockResolvedValue(true);
    const markup = renderToStaticMarkup(
      await RootLayout({ children: createElement("p", null, "operator content") }),
    );
    expect(markup).toContain('href="/admin"');
    expect(markup).toContain("Sign out");
  });

  it("renders only the sign-in experience for an anonymous admin request", async () => {
    const markup = renderToStaticMarkup(await AdminPage());
    expect(markup).toContain("Protected operator surface");
    expect(markup).not.toContain("Admin console");
    expect(markup).not.toContain("Reset Demo");
  });

  it("performs operator reads and renders the authenticated Admin tree", async () => {
    sessionMock.mockResolvedValue(true);
    const markup = renderToStaticMarkup(await AdminPage());
    expect(markup).toContain("Admin console");
    expect(markup).toContain("Authenticated console data");
    expect(markup).not.toContain("Admin passphrase");
    expect(adminReads.erp).toHaveBeenCalledOnce();
    expect(adminReads.presets).toHaveBeenCalledOnce();
    expect(adminReads.policy).toHaveBeenCalledOnce();
  });

  it("keeps History public while including cleanup only in authenticated server HTML", async () => {
    const anonymous = renderToStaticMarkup(
      await RunHistoryPage({ searchParams: Promise.resolve({ page: "1" }) }),
    );
    expect(anonymous).toContain("Public history list");
    expect(anonymous).not.toContain("Authenticated history cleanup");

    sessionMock.mockResolvedValue(true);
    const authenticated = renderToStaticMarkup(
      await RunHistoryPage({ searchParams: Promise.resolve({ page: "1" }) }),
    );
    expect(authenticated).toContain("Public history list");
    expect(authenticated).toContain("Authenticated history cleanup");
  });
});
