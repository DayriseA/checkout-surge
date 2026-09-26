// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmationDialog } from "../src/app/components/confirmation-dialog.js";

afterEach(cleanup);

describe("ConfirmationDialog", () => {
  it("keeps the labelled native dialog mounted and renders its destructive content", async () => {
    const { rerender } = renderDialog({ open: false });
    const dialog = screen.getByRole("alertdialog", { hidden: true });
    expect((dialog as HTMLDialogElement).open).toBe(false);

    rerender(dialogElement({ error: "The reset failed.", open: true, withInput: true }));
    await waitFor(() => expect((dialog as HTMLDialogElement).open).toBe(true));
    expect(screen.getByRole("alertdialog", { name: "Reset shared state?" })).toBe(dialog);
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("Destructive action")).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveProperty("textContent", "The reset failed.");
    expect(screen.getByRole("textbox", { name: "Confirmation value" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" }).classList).toContain(
      "border-control-border",
    );
    expect(screen.getByRole("button", { name: "Cancel" }).classList).toContain("min-h-11");
    expect(dialog.innerHTML).not.toContain("bg-bg");

    rerender(dialogElement({ open: false }));
    await waitFor(() => expect((dialog as HTMLDialogElement).open).toBe(false));
    expect(screen.getByRole("alertdialog", { hidden: true })).toBe(dialog);
  });

  it("routes native cancel while idle and vetoes dismissal while pending", async () => {
    const onCancel = vi.fn();
    const { rerender } = renderDialog({ onCancel, open: true });
    const dialog = screen.getByRole("alertdialog");
    expect(fireEvent(dialog, new Event("cancel", { cancelable: true }))).toBe(false);
    expect(onCancel).toHaveBeenCalledOnce();
    expect((dialog as HTMLDialogElement).open).toBe(true);

    rerender(dialogElement({ onCancel, open: true, pending: true }));
    expect(fireEvent(dialog, new Event("cancel", { cancelable: true }))).toBe(false);
    expect(onCancel).toHaveBeenCalledOnce();
    expect((dialog as HTMLDialogElement).open).toBe(true);
  });

  it("guards pending and disabled actions while keeping idle actions wired", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderDialog({ onCancel, onConfirm, open: true });
    await user.click(screen.getByRole("button", { name: "Reset state" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(dialogElement({ confirmDisabled: true, onCancel, onConfirm, open: true }));
    expect(
      (screen.getByRole("button", { name: "Reset state" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    rerender(dialogElement({ onCancel, onConfirm, open: true, pending: true }));
    expect((screen.getByRole("button", { name: "Working…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("renders a non-destructive confirmation without danger styling", () => {
    render(
      <ConfirmationDialog
        confirmLabel="Start run"
        description="Start with this configuration."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        open
        title="Start this run?"
        tone="default"
      />,
    );
    expect(screen.queryByText("Destructive action")).toBeNull();
    expect(screen.getByRole("button", { name: "Start run" }).classList).toContain("bg-accent");
  });

  it("does not attach backdrop-click dismissal behavior", () => {
    const onCancel = vi.fn();
    renderDialog({ onCancel, open: true });
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(dialog);
    expect(onCancel).not.toHaveBeenCalled();
    expect((dialog as HTMLDialogElement).open).toBe(true);
  });
});

interface DialogOptions {
  confirmDisabled?: boolean;
  error?: string | null;
  onCancel?: () => void;
  onConfirm?: () => void;
  open: boolean;
  pending?: boolean;
  withInput?: boolean;
}

function renderDialog(options: DialogOptions) {
  return render(dialogElement(options));
}

function dialogElement({
  confirmDisabled = false,
  error = null,
  onCancel = vi.fn(),
  onConfirm = vi.fn(),
  open,
  pending = false,
  withInput = false,
}: DialogOptions) {
  return (
    <ConfirmationDialog
      confirmDisabled={confirmDisabled}
      confirmLabel="Reset state"
      description="This permanently resets shared state."
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      pending={pending}
      title="Reset shared state?"
    >
      {withInput ? <input aria-label="Confirmation value" /> : null}
    </ConfirmationDialog>
  );
}
