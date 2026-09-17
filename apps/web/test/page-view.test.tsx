// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdvancedOnly,
  BasicOnly,
  PageView,
  RevealAdvancedHashTarget,
  RevealAdvancedLink,
  ViewModeSwitch,
  ViewPreferenceProvider,
} from "../src/app/components/page-view.js";
import {
  parseViewMode,
  type ViewMode,
  viewModeCookieName,
} from "../src/app/lib/presentation/view-mode.js";

afterEach(cleanup);

beforeEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API.
  document.cookie = `${viewModeCookieName}=; Max-Age=0; Path=/`;
  window.location.hash = "";
});

function WatchView({
  initialMode,
  participating = true,
}: {
  initialMode: ViewMode;
  participating?: boolean;
}) {
  return (
    <ViewPreferenceProvider initialMode={initialMode}>
      <ViewModeSwitch />
      {participating ? (
        <PageView>
          <p>Shared summary</p>
          <BasicOnly id="basic-section">
            <p>Basic guidance</p>
          </BasicOnly>
          <AdvancedOnly id="technical-section">
            <p>Technical measurements</p>
          </AdvancedOnly>
        </PageView>
      ) : null}
    </ViewPreferenceProvider>
  );
}

function view(initialMode: ViewMode, children: React.ReactNode) {
  return (
    <ViewPreferenceProvider initialMode={initialMode}>
      <ViewModeSwitch />
      <PageView>{children}</PageView>
    </ViewPreferenceProvider>
  );
}

describe("view mode helpers", () => {
  it("parses cookie values strictly and defines one global cookie", () => {
    expect(parseViewMode("advanced")).toBe("advanced");
    expect(parseViewMode("ADVANCED")).toBe("basic");
    expect(parseViewMode("true")).toBe("basic");
    expect(parseViewMode(undefined)).toBe("basic");
    expect(parseViewMode(null)).toBe("basic");
    expect(viewModeCookieName).toBe("checkout-surge.view");
  });
});

describe("PageView", () => {
  it("server-renders saved content while omitting the switch until participation registers", () => {
    const basicDocument = new DOMParser().parseFromString(
      renderToString(<WatchView initialMode="basic" />),
      "text/html",
    );
    expect(basicDocument.querySelector('[role="switch"]')).toBeNull();
    expect(basicDocument.getElementById("basic-section")?.hasAttribute("hidden")).toBe(false);
    expect(basicDocument.getElementById("technical-section")?.hasAttribute("hidden")).toBe(true);
    expect(basicDocument.getElementById("technical-section")?.textContent).toContain(
      "Technical measurements",
    );

    const advancedDocument = new DOMParser().parseFromString(
      renderToString(<WatchView initialMode="advanced" />),
      "text/html",
    );
    expect(advancedDocument.querySelector('[role="switch"]')).toBeNull();
    expect(advancedDocument.getElementById("technical-section")?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(advancedDocument.getElementById("basic-section")?.hasAttribute("hidden")).toBe(true);
  });

  it.each<ViewMode>([
    "basic",
    "advanced",
  ])("hydrates saved %s markup without warnings or cookie writes", async (initialMode) => {
    const serverMarkup = renderToString(<WatchView initialMode={initialMode} />);
    const next = document.createElement("div");
    next.innerHTML = serverMarkup;
    document.body.appendChild(next);
    const recoverableErrors: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(next, <WatchView initialMode={initialMode} />, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    expect(recoverableErrors).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(next.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe(
      String(initialMode === "advanced"),
    );
    expect(next.querySelector("#technical-section")?.hasAttribute("hidden")).toBe(
      initialMode === "basic",
    );
    await act(async () => root?.unmount());
    next.remove();
    consoleError.mockRestore();
  });

  it("toggles mounted content and persists one global cookie", () => {
    const { container } = render(<WatchView initialMode="basic" />);
    const toggle = screen.getByRole("switch", { name: "Advanced" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(toggle);
    expect(document.cookie).toContain(`${viewModeCookieName}=advanced`);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("#technical-section")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector("#basic-section")?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(toggle);
    expect(document.cookie).toContain(`${viewModeCookieName}=basic`);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("#technical-section")?.hasAttribute("hidden")).toBe(true);
  });

  it("shows the switch only while a PageView participates and retains its mode", () => {
    const { rerender } = render(<WatchView initialMode="advanced" />);
    expect(screen.getByRole("switch", { name: "Advanced" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    rerender(<WatchView initialMode="advanced" participating={false} />);
    expect(screen.queryByRole("switch", { name: "Advanced" })).toBeNull();
    rerender(<WatchView initialMode="advanced" />);
    expect(screen.getByRole("switch", { name: "Advanced" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("reveal links enable advanced and focus the target", () => {
    const { container } = render(
      view(
        "basic",
        <>
          <AdvancedOnly id="technical-section">Technical measurements</AdvancedOnly>
          <RevealAdvancedLink targetId="technical-section">View measurements</RevealAdvancedLink>
        </>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "View measurements" }));
    expect(document.cookie).toContain(`${viewModeCookieName}=advanced`);
    const target = container.querySelector("#technical-section");
    expect(target?.hasAttribute("hidden")).toBe(false);
    expect(document.activeElement).toBe(target);
  });

  it("reveals an initial advanced hash once and permits switching off", () => {
    window.location.hash = "#technical-section";
    const { container } = render(
      view(
        "basic",
        <>
          <RevealAdvancedHashTarget />
          <AdvancedOnly>
            <section id="technical-section" tabIndex={-1}>
              Technical measurements
            </section>
          </AdvancedOnly>
        </>,
      ),
    );
    const toggle = screen.getByRole("switch", { name: "Advanced" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(container.querySelector("#technical-section"));
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      container
        .querySelector("#technical-section")
        ?.closest("[data-advanced-only]")
        ?.hasAttribute("hidden"),
    ).toBe(true);
  });

  it("returns focus to the switch when hiding focused advanced content", () => {
    const { container } = render(
      view(
        "advanced",
        <AdvancedOnly id="technical-section">
          <button type="button">Inside advanced</button>
        </AdvancedOnly>,
      ),
    );
    const inside = screen.getByRole("button", { name: "Inside advanced" });
    inside.focus();
    const toggle = screen.getByRole("switch", { name: "Advanced" });
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(container.querySelector("#technical-section")?.hasAttribute("hidden")).toBe(true);
  });

  it("keeps advanced children mounted with state across switches", () => {
    render(
      view(
        "basic",
        <AdvancedOnly>
          <DraftCounter />
        </AdvancedOnly>,
      ),
    );
    const toggle = screen.getByRole("switch", { name: "Advanced" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Edits 0" }));
    fireEvent.click(screen.getByRole("button", { name: "Edits 1" }));
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Edits 2" })).toBeTruthy();
  });
});

function DraftCounter() {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount(count + 1)} type="button">
      Edits {count}
    </button>
  );
}
