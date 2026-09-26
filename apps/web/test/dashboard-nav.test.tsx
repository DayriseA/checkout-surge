// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardNav } from "../src/app/components/dashboard-nav.js";

const pathname = vi.hoisted(() => ({ value: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

afterEach(cleanup);

function renderNavigation(children: React.ReactNode) {
  return <DashboardNav>{children}</DashboardNav>;
}

describe("DashboardNav", () => {
  it.each([
    ["/", "Overview"],
    ["/watch", "Watch"],
    ["/run-history/some-run-id", "Run history"],
  ])("marks the current dashboard route for %s", (currentPathname, expectedName) => {
    pathname.value = currentPathname;
    render(renderNavigation(null));

    const currentLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.textContent).toBe(expectedName);
  });

  it("styles the current link and leaves every other link muted", () => {
    pathname.value = "/watch";
    render(renderNavigation(null));

    const navigation = screen.getByRole("navigation", { name: "Dashboard routes" });
    const currentLink = screen
      .getAllByRole("link")
      .find((link) => link.getAttribute("aria-current") === "page");
    expect(currentLink?.classList.contains("text-white")).toBe(true);
    expect(currentLink?.classList.contains("after:bg-signal")).toBe(true);
    expect(currentLink?.classList.contains("text-white/70")).toBe(false);
    expect(currentLink?.classList.contains("max-[900px]:bg-surface-muted")).toBe(true);

    for (const link of navigation.querySelectorAll("a:not([aria-current])")) {
      expect(link.classList.contains("text-white/70")).toBe(true);
      expect(link.classList.contains("text-white")).toBe(false);
      expect(link.classList.contains("after:bg-signal")).toBe(false);
    }
  });

  it("opens by keyboard and exposes every route, Repository, and the children slot", async () => {
    const user = userEvent.setup();
    render(renderNavigation(<button type="button">Sign out</button>));

    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.classList).toContain("min-h-11");
    expect(toggle.classList).toContain("border-white/30");

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId as string);
    expect(panel).not.toBeNull();
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
      "Overview",
      "Demo",
      "Watch",
      "Run history",
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
});
