"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";

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
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  return (
    <dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="w-full max-w-lg rounded-lg border border-danger bg-surface p-5 shadow-xl backdrop:bg-black/55"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      ref={dialogRef}
      role="alertdialog"
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
          // biome-ignore lint/a11y/noAutofocus: Destructive confirmations initially focus the least-destructive action.
          autoFocus
          className="min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:opacity-60"
          disabled={pending}
          onClick={onCancel}
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
    </dialog>
  );
}
