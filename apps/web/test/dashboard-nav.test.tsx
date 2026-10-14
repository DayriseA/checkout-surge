// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardNav } from "../src/app/components/dashboard-nav.js";
import { localeCookieName } from "../src/app/lib/i18n/locale.js";
import { LocaleProvider } from "../src/app/lib/i18n/locale-context.js";

const pathname = vi.hoisted(() => ({ value: "/", refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathname.value,
  useRouter: () => ({ refresh: pathname.refresh }),
}));

afterEach(cleanup);

function renderNavigation(children: React.ReactNode) {
  return <DashboardNav>{children}</DashboardNav>;
}

describe("DashboardNav", () => {
  it("switches languages, persists the preference, and keeps the current route", async () => {
    const user = userEvent.setup();
    pathname.value = "/watch";
    const { rerender } = render(
      <LocaleProvider locale="en">{renderNavigation(null)}</LocaleProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Switch to French" }));
    expect(document.cookie).toContain(`${localeCookieName}=fr`);
    expect(pathname.refresh).toHaveBeenCalledOnce();

    rerender(<LocaleProvider locale="fr">{renderNavigation(null)}</LocaleProvider>);
    const current = screen.getByRole("link", { name: "Suivi en direct" });
    expect(current.getAttribute("href")).toBe("/watch");
    expect(current.getAttribute("aria-current")).toBe("page");
    await user.click(screen.getByRole("button", { name: "Passer en anglais" }));
    expect(document.cookie).toContain(`${localeCookieName}=en`);
    expect(pathname.refresh).toHaveBeenCalledTimes(2);
    pathname.refresh.mockClear();
  });
  it.each([
    ["/watch", "Watch"],
    ["/run-history/some-run-id", "Run history"],
    ["/how-it-works", "How it works"],
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
      "Demo",
      "Watch",
      "Run history",
      "How it works",
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
