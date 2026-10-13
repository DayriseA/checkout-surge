import Link from "next/link";
import type { ReactNode } from "react";
import { textLinkClassName } from "./control-styles";

/** The text styles of the content pages (How it works, Limits, Under the hood). */
export const proseClassName = "mt-3 max-w-[68ch] text-base leading-7 text-muted-strong";
export const listClassName =
  "mb-0 mt-3 grid max-w-[68ch] gap-1.5 pl-6 text-base leading-7 text-muted-strong";
export const subheadingClassName = "type-title m-0 mt-6 text-lg leading-snug text-ink";
export const noteClassName = "m-0 mt-3 max-w-[68ch] text-sm leading-6 text-muted";

/**
 * A content page: its title and lead, then its sections beside a sticky "On this page" list.
 * `contents` pairs each section's anchor with its label, in page order.
 */
export function ContentPage({
  children,
  contents,
  lead,
  title,
}: {
  children: ReactNode;
  contents: readonly (readonly [string, string])[];
  lead: string;
  title: string;
}) {
  return (
    <>
      <header className="pb-8 pt-4 max-[560px]:pb-6 max-[560px]:pt-0">
        <h1 className="type-display m-0 text-[clamp(2rem,5vw,3.5rem)] leading-[0.95] text-ink">
          {title}
        </h1>
        <p className="m-0 mt-4 max-w-[60ch] text-lg leading-7 text-muted-strong">{lead}</p>
      </header>
      <div className="grid grid-cols-[13rem_minmax(0,1fr)] items-start gap-10 rounded-2xl border border-border bg-surface px-10 py-10 max-[900px]:grid-cols-1 max-[900px]:gap-6 max-[900px]:px-6 max-[900px]:py-8 max-[560px]:px-4">
        <nav
          aria-label="On this page"
          className="sticky top-24 grid gap-0.5 text-sm max-[900px]:hidden"
        >
          <p className="m-0 mb-2 text-sm font-semibold text-ink">On this page</p>
          {contents.map(([id, label]) => (
            <a
              className="rounded-md border-l-2 border-border py-1 pl-3 text-muted hover:border-accent hover:text-ink"
              href={`#${id}`}
              key={id}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </>
  );
}

export function ContentSection({
  children,
  id,
  title,
}: {
  children: ReactNode;
  id: string;
  title: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-24 border-t border-border py-8 outline-none first:border-t-0 first:pt-0 max-[560px]:py-6"
      id={id}
      tabIndex={-1}
    >
      <h2 className="type-title m-0 text-2xl leading-tight text-ink" id={`${id}-heading`}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A link inside running text. External links open in a new tab and say so. */
export function TextLink({
  children,
  external = false,
  href,
}: {
  children: ReactNode;
  external?: boolean;
  href: string;
}) {
  return external ? (
    <a className={textLinkClassName} href={href} rel="noopener noreferrer" target="_blank">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  ) : (
    <Link className={textLinkClassName} href={href}>
      {children}
    </Link>
  );
}

/** The links a section or page ends with, on one line. */
export function LinkRow({
  className = "m-0 mt-4",
  links,
}: {
  className?: string;
  links: readonly { href: string; label: string }[];
}) {
  return (
    <p className={`flex flex-wrap gap-x-5 gap-y-2 text-sm ${className}`}>
      {links.map((link) => (
        <TextLink href={link.href} key={link.href}>
          {link.label} →
        </TextLink>
      ))}
    </p>
  );
}
