// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardNav } from "../src/app/components/dashboard-nav.js";

const pathname = vi.hoisted(() => ({ value: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

afterEach(cleanup);

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
    render(<DashboardNav>{null}</DashboardNav>);

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
});
