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

  it("opens by keyboard and exposes every route, Repository, and the children slot", async () => {
    const user = userEvent.setup();
    render(renderNavigation(<button type="button">Sign out</button>));

    const toggle = screen.getByRole("button", { name: "Menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId as string);
    expect(panel).not.toBeNull();
    const links = within(panel as HTMLElement).getAllByRole("link");
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
