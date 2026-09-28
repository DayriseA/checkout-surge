import type { ReactNode } from "react";
import { FieldHint } from "./field-hint";

export function ConfigGroup({
  caption,
  children,
  title,
  hint,
}: {
  caption?: string | undefined;
  children: ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <section className="min-w-0 border-t border-border pt-3">
      <h3 className="m-0 flex items-center gap-2 text-sm font-semibold text-ink">
        {title}
        {hint ? <FieldHint label={title} text={hint} /> : null}
      </h3>
      {caption ? <p className="m-0 mt-0.5 text-xs text-muted">{caption}</p> : null}
      <dl className="m-0 mt-2 grid max-w-[30rem] grid-cols-[minmax(0,max-content)_minmax(8rem,1fr)] gap-x-3 gap-y-1.5">
        {children}
      </dl>
    </section>
  );
}

export function FieldRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="contents">
      <dt className="flex items-center gap-2 text-sm text-muted">
        {label}
        {hint ? <FieldHint label={label} text={hint} /> : null}
      </dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink">
        {value}
      </dd>
    </div>
  );
}
