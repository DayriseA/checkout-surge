"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";
import {
  buttonClassName,
  dangerLinkButtonClassName,
  primaryButtonClassName,
} from "./control-styles";

export interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /** "danger" marks irreversible or data-losing actions; "default" is a plain confirmation. */
  tone?: "danger" | "default";
  /** Widens the dialog for tabular content such as run previews. */
  wide?: boolean;
  pending?: boolean;
  confirmDisabled?: boolean;
  error?: ReactNode;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = "danger",
  wide = false,
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
  const isDanger = tone === "danger";

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
      className={`m-auto w-[calc(100%-2rem)] ${wide ? "max-w-2xl" : "max-w-lg"} rounded-2xl border-0 bg-surface p-0 shadow-[0_30px_80px_-20px_rgb(13_27_42/0.55)] backdrop:bg-reservoir/60 backdrop:backdrop-blur-[2px]`}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      ref={dialogRef}
      role="alertdialog"
    >
      <div
        className={`rounded-t-2xl border-t-4 px-6 pt-5 ${isDanger ? "border-danger" : "border-accent"}`}
      >
        {isDanger ? (
          <p className="m-0 mb-1 flex items-center gap-1.5 text-xs font-semibold text-danger">
            <span aria-hidden="true">⚠</span>Destructive action
          </p>
        ) : null}
        <h2 className="type-title m-0 text-xl leading-tight text-ink" id={titleId}>
          {title}
        </h2>
        <p className="mb-0 mt-3 leading-6 text-muted-strong" id={descriptionId}>
          {description}
        </p>
      </div>
      {children ? <div className="mt-4 px-6 text-sm">{children}</div> : null}
      {error ? (
        typeof error === "string" ? (
          <p
            aria-live="polite"
            className="mx-6 mb-0 mt-4 text-sm font-semibold text-danger"
            role="alert"
          >
            {error}
          </p>
        ) : (
          <div className="mt-4 px-6">{error}</div>
        )
      ) : null}
      <div className="mt-6 flex flex-wrap justify-end gap-2 rounded-b-2xl border-t border-border bg-surface-muted px-6 py-4">
        <button
          // biome-ignore lint/a11y/noAutofocus: Destructive confirmations initially focus the least-destructive action.
          autoFocus
          className={buttonClassName}
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className={isDanger ? dangerLinkButtonClassName : primaryButtonClassName}
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
