// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdvancedOnly,
  PageView,
  RevealAdvancedLink,
  useViewMode,
} from "../src/app/components/page-view.js";
import {
  parseViewMode,
  type ViewMode,
  viewModeCookieName,
} from "../src/app/lib/presentation/view-mode.js";

afterEach(cleanup);

beforeEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; the test resets the cookie the same way the component writes it.
  document.cookie = "checkout-surge.view.watch=; Max-Age=0; Path=/";
});

function WatchView({ initialMode }: { initialMode: ViewMode }) {
  return (
    <PageView initialMode={initialMode} page="watch">
      <p>Shared summary</p>
      <AdvancedOnly id="technical-section">
        <p>Technical measurements</p>
      </AdvancedOnly>
    </PageView>
  );
}

describe("view mode helpers", () => {
  it("parses cookie values strictly and names cookies per page", () => {
    expect(parseViewMode("advanced")).toBe("advanced");
    expect(parseViewMode("ADVANCED")).toBe("basic");
    expect(parseViewMode("true")).toBe("basic");
    expect(parseViewMode(undefined)).toBe("basic");
    expect(parseViewMode(null)).toBe("basic");
    expect(viewModeCookieName("watch")).toBe("checkout-surge.view.watch");
    expect(viewModeCookieName("report")).toBe("checkout-surge.view.report");
  });
});

describe("PageView", () => {
  it("server-renders the initial mode with the right radio checked and sections hidden", () => {
    const basicDocument = new DOMParser().parseFromString(
      renderToString(<WatchView initialMode="basic" />),
      "text/html",
    );
    const basicChecked = basicDocument.querySelector(
      'input[name="view-watch"][value="basic"]',
    ) as HTMLInputElement;
    const basicSection = basicDocument.getElementById("technical-section");
    expect(basicChecked.checked).toBe(true);
    expect(basicSection?.hasAttribute("hidden")).toBe(true);
    expect(basicSection?.textContent).toContain("Technical measurements");

    const advancedDocument = new DOMParser().parseFromString(
      renderToString(<WatchView initialMode="advanced" />),
      "text/html",
    );
    const advancedChecked = advancedDocument.querySelector(
      'input[name="view-watch"][value="advanced"]',
    ) as HTMLInputElement;
    expect(advancedChecked.checked).toBe(true);
    expect(advancedDocument.getElementById("technical-section")?.hasAttribute("hidden")).toBe(
      false,
    );
  });

  it.each<ViewMode>([
    "basic",
    "advanced",
  ])("hydrates saved %s markup without hydration warnings or cookie writes", async (initialMode) => {
    const serverMarkup = renderToString(<WatchView initialMode={initialMode} />);
    const next = document.createElement("div");
    next.innerHTML = serverMarkup;
    document.body.appendChild(next);

    const recoverableErrors: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(next, <WatchView initialMode={initialMode} />, {
        onRecoverableError: (error) => {
          recoverableErrors.push(error);
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(recoverableErrors).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(
      (next.querySelector(`input[name="view-watch"][value="${initialMode}"]`) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(next.querySelector("#technical-section")?.hasAttribute("hidden")).toBe(
      initialMode === "basic",
    );
    await act(async () => {
      root?.unmount();
    });
    next.remove();
    consoleError.mockRestore();
  });

  it("switching radios writes the per-page cookie and toggles the hidden attribute only", () => {
    const { container } = render(<WatchView initialMode="basic" />);
    expect(screen.getByRole("group", { name: "View" })).toBeTruthy();
    expect(document.cookie).toBe("");

    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));

    expect(document.cookie).toContain("checkout-surge.view.watch=advanced");
    expect((screen.getByRole("radio", { name: "Advanced" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(container.querySelector("#technical-section")?.hasAttribute("hidden")).toBe(false);
    expect(container.textContent).toContain("Shared summary");

    fireEvent.click(screen.getByRole("radio", { name: "Basic" }));

    expect(document.cookie).toContain("checkout-surge.view.watch=basic");
    expect(container.querySelector("#technical-section")?.hasAttribute("hidden")).toBe(true);
  });

  it("reveal link switches to advanced and moves focus to the target section", () => {
    const { container } = render(
      <PageView initialMode="basic" page="watch">
        <AdvancedOnly id="technical-section">
          <p>Technical measurements</p>
        </AdvancedOnly>
        <RevealAdvancedLink targetId="technical-section">
          View technical measurements
        </RevealAdvancedLink>
      </PageView>,
    );

    fireEvent.click(screen.getByRole("button", { name: "View technical measurements" }));

    expect(document.cookie).toContain("checkout-surge.view.watch=advanced");
    const target = container.querySelector("#technical-section");
    expect(target?.hasAttribute("hidden")).toBe(false);
    expect(document.activeElement).toBe(target);
  });

  it("moves focus to the control when returning to basic hides the focused section", () => {
    const { container } = render(
      <PageView initialMode="advanced" page="watch">
        <AdvancedOnly id="technical-section">
          <ReturnToBasic />
        </AdvancedOnly>
      </PageView>,
    );

    const insideButton = screen.getByRole("button", { name: "Switch to basic" });
    insideButton.focus();
    fireEvent.click(insideButton);

    const basicRadio = screen.getByRole("radio", { name: "Basic" }) as HTMLInputElement;
    expect(basicRadio.checked).toBe(true);
    expect(document.activeElement).toBe(basicRadio);
    expect(container.querySelector("#technical-section")?.hasAttribute("hidden")).toBe(true);
  });

  it("keeps advanced children mounted with their state across switches", () => {
    render(
      <PageView initialMode="basic" page="watch">
        <AdvancedOnly id="technical-section">
          <DraftCounter />
        </AdvancedOnly>
      </PageView>,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Edits 0" }));
    fireEvent.click(screen.getByRole("button", { name: "Edits 1" }));

    fireEvent.click(screen.getByRole("radio", { name: "Basic" }));
    fireEvent.click(screen.getByRole("radio", { name: "Advanced" }));

    expect(screen.getByRole("button", { name: "Edits 2" })).toBeTruthy();
  });
});

function ReturnToBasic() {
  const { setMode } = useViewMode();
  return (
    <button onClick={() => setMode("basic")} type="button">
      Switch to basic
    </button>
  );
}

function DraftCounter() {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount(count + 1)} type="button">
      Edits {count}
    </button>
  );
}
