import type { ReactNode } from "react";

export function ConfigGroup({
  caption,
  children,
  title,
}: {
  caption?: string | undefined;
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="min-w-0 border-t border-border pt-3">
      <h3 className="m-0 text-sm font-bold text-ink">{title}</h3>
      {caption ? <p className="m-0 mt-0.5 text-xs text-muted">{caption}</p> : null}
      <dl className="m-0 mt-3 grid gap-2">{children}</dl>
    </section>
  );
}

export function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="m-0 max-w-48 [overflow-wrap:anywhere] text-right text-sm font-semibold text-muted-strong">
        {value}
      </dd>
    </div>
  );
}
