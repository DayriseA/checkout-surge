// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationDialog } from "../src/app/components/confirmation-dialog.js";

afterEach(cleanup);

describe("ConfirmationDialog", () => {
  it("labels the alert dialog, focuses Cancel, wraps focus, shows errors, and restores its trigger", async () => {
    const user = userEvent.setup();
    render(<DialogHarness error="The reset failed." withInput />);
    const trigger = screen.getByRole("button", { name: "Open confirmation" });
    await user.click(trigger);

    const dialog = screen.getByRole("alertdialog", { name: "Reset shared state?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("The reset failed.");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Reset state" });
    const input = screen.getByRole("textbox", { name: "Confirmation value" });
    expect(document.activeElement).toBe(cancel);

    input.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(input);
    cancel.focus();
    await user.click(cancel);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on idle Escape but deliberately keeps backdrop clicks inside the dialog", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Open confirmation" }));
    fireEvent.click(screen.getByTestId("confirmation-backdrop"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("contains focus with one focusable control and recaptures focus entering from outside", async () => {
    const user = userEvent.setup();
    render(<DialogHarness confirmDisabled />);
    const outside = screen.getByRole("button", { name: "Outside" });
    await user.click(screen.getByRole("button", { name: "Open confirmation" }));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    outside.focus();
    expect(document.activeElement).toBe(cancel);
  });

  it("locks dismissal and duplicate confirmation while pending even with zero focusables", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<DialogHarness onConfirm={onConfirm} pending />);
    await user.click(screen.getByRole("button", { name: "Open confirmation" }));
    const dialog = screen.getByRole("alertdialog");
    const outside = screen.getByRole("button", { name: "Outside" });
    expect(document.activeElement).toBe(dialog);
    await user.keyboard("{Escape}");
    expect(dialog).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(dialog);
    outside.focus();
    expect(document.activeElement).toBe(dialog);
    await user.click(screen.getByRole("button", { name: "Working…" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("lets only the topmost dialog handle Escape and restore focus", async () => {
    const user = userEvent.setup();
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    const { rerender } = render(
      <StackedDialogs secondOpen onFirstCancel={closeFirst} onSecondCancel={closeSecond} />,
    );
    expect(document.activeElement).toBe(screen.getAllByRole("button", { name: "Cancel" })[1]);
    await user.keyboard("{Escape}");
    expect(closeFirst).not.toHaveBeenCalled();
    expect(closeSecond).toHaveBeenCalledOnce();

    rerender(
      <StackedDialogs secondOpen={false} onFirstCancel={closeFirst} onSecondCancel={closeSecond} />,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(closeFirst).toHaveBeenCalledOnce();
  });
});

function DialogHarness({
  confirmDisabled = false,
  error = null,
  onConfirm = vi.fn(),
  pending = false,
  withInput = false,
}: {
  confirmDisabled?: boolean;
  error?: string | null;
  onConfirm?: () => void;
  pending?: boolean;
  withInput?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open confirmation
      </button>
      <button type="button">Outside</button>
      <ConfirmationDialog
        confirmDisabled={confirmDisabled}
        confirmLabel="Reset state"
        description="This permanently resets shared state."
        error={error}
        onCancel={() => setOpen(false)}
        onConfirm={onConfirm}
        open={open}
        pending={pending}
        title="Reset shared state?"
      >
        {withInput ? <input aria-label="Confirmation value" /> : null}
      </ConfirmationDialog>
    </>
  );
}

function StackedDialogs({
  secondOpen,
  onFirstCancel,
  onSecondCancel,
}: {
  secondOpen: boolean;
  onFirstCancel: () => void;
  onSecondCancel: () => void;
}) {
  return (
    <>
      <button type="button">First trigger</button>
      <ConfirmationDialog
        confirmLabel="Confirm first"
        description="First description"
        onCancel={onFirstCancel}
        onConfirm={vi.fn()}
        open
        title="First dialog"
      />
      <ConfirmationDialog
        confirmLabel="Confirm second"
        description="Second description"
        onCancel={onSecondCancel}
        onConfirm={vi.fn()}
        open={secondOpen}
        title="Second dialog"
      />
    </>
  );
}
