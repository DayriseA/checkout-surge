// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardNav } from "../src/app/components/dashboard-nav.js";
import { PageView, ViewPreferenceProvider } from "../src/app/components/page-view.js";

const pathname = vi.hoisted(() => ({ value: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

afterEach(cleanup);

function renderNavigation(children: React.ReactNode, participating = false) {
  return (
    <ViewPreferenceProvider initialMode="basic">
      <DashboardNav>{children}</DashboardNav>
      {participating ? (
        <PageView>
          <span>Page</span>
        </PageView>
      ) : null}
    </ViewPreferenceProvider>
  );
}

describe("DashboardNav", () => {
  it.each([
    ["/", "Demo"],
    ["/watch", "Watch"],
    ["/run-history", "Run history"],
    ["/run-history/some-run-id", "Run history"],
    ["/about", "About"],
    ["/admin", "Admin"],
  ])("marks the current dashboard route for %s", (currentPathname, expectedName) => {
    pathname.value = currentPathname;
    render(renderNavigation(null));

    const navigation = screen.getByRole("navigation", { name: "Dashboard routes" });
    const currentLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.textContent).toBe(expectedName);
    expect(currentLinks[0]?.classList.contains("bg-surface-muted")).toBe(true);
    expect(currentLinks[0]?.classList.contains("text-ink")).toBe(true);
    expect(currentLinks[0]?.classList.contains("text-muted-strong")).toBe(false);
    expect(currentLinks[0]?.classList.contains("underline")).toBe(true);
    expect(currentLinks[0]?.classList.contains("underline-offset-4")).toBe(true);

    for (const link of navigation.querySelectorAll("a:not([aria-current])")) {
      expect(link.classList.contains("text-muted-strong")).toBe(true);
      expect(link.classList.contains("text-ink")).toBe(false);
      expect(link.classList.contains("underline")).toBe(false);
    }
  });

  it("opens by keyboard and exposes every route, Repository, and the children slot", async () => {
    const user = userEvent.setup();
    render(renderNavigation(<button type="button">Sign out</button>));

    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.classList).toContain("min-h-11");
    expect(toggle.classList).toContain("border-control-border");

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId as string);
    expect(panel).not.toBeNull();
    expect(panel?.id).toBe(panelId);
    expect(panel?.classList).toContain("max-[900px]:max-h-[calc(100dvh-5rem)]");
    expect(panel?.classList).toContain("max-[900px]:overflow-y-auto");
    expect(panel?.classList).toContain("max-[900px]:flex-nowrap");
    expect(panel?.classList).toContain("max-[900px]:justify-start");
    const links = within(panel as HTMLElement).getAllByRole("link");
    for (const link of links) {
      expect(link.classList).toContain("min-h-11");
      expect(link.classList).toContain("inline-flex");
    }
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "Demo",
      "Watch",
      "Run history",
      "About",
      "Admin",
      "Repository (opens in a new tab)",
    ]);
    expect(within(panel as HTMLElement).getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("closes on Escape and returns focus to the toggle", async () => {
    const user = userEvent.setup();
    render(renderNavigation(null));
    const toggle = screen.getByRole("button", { name: "Menu" });

    await user.click(toggle);
    screen.getByRole("link", { name: "Watch" }).focus();
    await user.keyboard("{Escape}");

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes on an outside pointer-down", async () => {
    const user = userEvent.setup();
    render(renderNavigation(null));
    const toggle = screen.getByRole("button", { name: "Menu" });

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when the pathname changes", async () => {
    const user = userEvent.setup();
    pathname.value = "/";
    const { rerender } = render(renderNavigation(null));
    const toggle = screen.getByRole("button", { name: "Menu" });
    await user.click(toggle);

    pathname.value = "/watch";
    rerender(renderNavigation(null));

    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
  });

  it("keeps the participating view switch outside the mobile menu panel", () => {
    render(renderNavigation(null, true));
    const toggle = screen.getByRole("switch", { name: "Advanced" });
    const menu = screen.getByRole("button", { name: "Menu" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.closest("#dashboard-navigation-panel")).toBeNull();
    expect(toggle.classList).toContain("min-h-11");
    expect(menu.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});
