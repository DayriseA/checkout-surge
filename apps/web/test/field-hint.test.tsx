// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FieldHint } from "../src/app/components/field-hint.js";

afterEach(cleanup);

describe("FieldHint", () => {
  it("opens on focus and click, closes on Escape and outside click, and does not toggle a checkbox", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <label>
          <input type="checkbox" />
          Enable option
        </label>
        <FieldHint label="Enable option" text="What this option does." />
        <button type="button">Outside</button>
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "About Enable option" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await user.tab();
    await user.tab();
    expect(screen.getByRole("tooltip").textContent).toBe("What this option does.");
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.blur(trigger, { relatedTarget: screen.getByRole("button", { name: "Outside" }) });
    fireEvent.focus(trigger);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.click(trigger);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.click(trigger);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });

  it("does not toggle details when a summary hint is clicked", async () => {
    const user = userEvent.setup();
    render(
      <details>
        <summary>
          Advanced protection settings{" "}
          <FieldHint label="Advanced protection settings" text="Safety limits." />
        </summary>
        <p>Collapsed content</p>
      </details>,
    );
    const details = screen
      .getByText("Advanced protection settings")
      .closest("details") as HTMLDetailsElement;
    const trigger = screen.getByRole("button", { name: "About Advanced protection settings" });
    expect(details.open).toBe(false);
    expect(trigger.closest("summary")).toBeTruthy();
    await user.click(trigger);
    expect(details.open).toBe(false);
    expect(screen.getByRole("tooltip").textContent).toBe("Safety limits.");

    trigger.focus();
    await user.keyboard("{Enter}");
    expect(details.open).toBe(false);
    await user.keyboard(" ");
    expect(details.open).toBe(false);

    await user.click(screen.getByText("Advanced protection settings"));
    expect(details.open).toBe(true);
    await user.click(trigger);
    expect(details.open).toBe(true);
  });
});
