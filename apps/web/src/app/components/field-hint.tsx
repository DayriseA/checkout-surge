"use client";

import { useEffect, useId, useRef, useState } from "react";

export function FieldHint({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setOpen(false);
      setDismissed(true);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const closeSoon = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 160);
  };
  const cancelClose = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <span className="relative inline-flex align-middle" ref={root}>
      <button
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        aria-label={`About ${label}`}
        className="inline-flex size-5 cursor-help items-center justify-center rounded-full bg-surface-muted text-[0.6875rem] font-bold text-muted ring-1 ring-inset ring-border transition-colors hover:bg-accent hover:text-white hover:ring-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink aria-expanded:bg-accent aria-expanded:text-white aria-expanded:ring-accent"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          cancelClose();
          setDismissed(false);
          setOpen(true);
        }}
        onBlur={(event) => {
          if (!root.current?.contains(event.relatedTarget as Node)) closeSoon();
        }}
        onFocus={() => {
          cancelClose();
          setDismissed(false);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        onMouseEnter={() => {
          cancelClose();
          if (!dismissed) setOpen(true);
        }}
        onMouseLeave={() => {
          setDismissed(false);
          closeSoon();
        }}
        type="button"
      >
        <span aria-hidden="true">?</span>
      </button>
      {open ? (
        <span
          className="absolute left-0 top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-reservoir px-3 py-2.5 text-left text-[0.8125rem] font-normal normal-case leading-5 tracking-normal text-white shadow-[0_12px_32px_-8px_rgb(13_27_42/0.45)] [font-stretch:100%]"
          id={id}
          role="tooltip"
          onMouseEnter={cancelClose}
          onMouseLeave={closeSoon}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}
