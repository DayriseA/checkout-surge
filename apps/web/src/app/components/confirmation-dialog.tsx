"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

const openDialogStack: symbol[] = [];

function isTopDialog(dialogId: symbol): boolean {
  return openDialogStack.at(-1) === dialogId;
}

export interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  confirmDisabled?: boolean;
  error?: string | null;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  confirmDisabled = false,
  error,
  children,
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const dialogIdRef = useRef(Symbol("confirmation-dialog"));
  const pendingRef = useRef(pending);
  const onCancelRef = useRef(onCancel);
  pendingRef.current = pending;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    const dialogId = dialogIdRef.current;
    triggerRef.current = document.activeElement as HTMLElement | null;
    openDialogStack.push(dialogId);
    function focusInside() {
      const focusable = focusableElements(dialogRef.current);
      (focusable.item(0) ?? dialogRef.current)?.focus();
    }
    cancelRef.current?.focus();
    if (!dialogRef.current?.contains(document.activeElement)) focusInside();
    function onKeyDown(event: KeyboardEvent) {
      if (!isTopDialog(dialogId)) return;
      if (event.key === "Escape" && !pendingRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable.item(0);
      const last = focusable.item(focusable.length - 1);
      const activeInside = dialogRef.current?.contains(document.activeElement);
      if (!activeInside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (focusable.length === 1) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    function onFocusIn(event: FocusEvent) {
      if (
        isTopDialog(dialogId) &&
        event.target instanceof Node &&
        !dialogRef.current?.contains(event.target)
      ) {
        focusInside();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      const wasTop = isTopDialog(dialogId);
      const index = openDialogStack.lastIndexOf(dialogId);
      if (index >= 0) openDialogStack.splice(index, 1);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      if (wasTop) triggerRef.current?.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4"
      data-testid="confirmation-backdrop"
    >
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="w-full max-w-lg rounded-lg border border-danger bg-surface p-5 shadow-xl"
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <p className="m-0 text-xs font-bold uppercase text-danger">Destructive action</p>
        <h2 className="m-0 mt-1 text-xl font-bold text-ink" id={titleId}>
          {title}
        </h2>
        <p className="mt-3 leading-6 text-muted-strong" id={descriptionId}>
          {description}
        </p>
        {children ? <div className="mt-4">{children}</div> : null}
        {error ? (
          <p aria-live="polite" className="mt-4 text-sm font-semibold text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            className="min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:opacity-60"
            disabled={pending}
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            Cancel
          </button>
          <button
            className="min-h-10 rounded-lg border border-danger bg-danger-soft px-3.5 py-2.5 font-semibold text-danger disabled:opacity-60"
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
            type="button"
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function focusableElements(container: HTMLElement | null): NodeListOf<HTMLElement> {
  return (
    container?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? document.createElement("div").querySelectorAll<HTMLElement>("*")
  );
}
