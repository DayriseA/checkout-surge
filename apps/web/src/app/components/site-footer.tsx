import Link from "next/link";
import { publicNarrative } from "../lib/presentation/public-vocabulary";
import { siteLink, sitePages } from "../lib/site-links";

const footerLinks = [
  { href: sitePages.howItWorks, label: "How it works" },
  { href: sitePages.underTheHood, label: "Under the hood" },
  { href: sitePages.limits, label: "Limits and known defects" },
  { href: siteLink("underTheHood", "glossary"), label: "Glossary" },
] as const;

const footerLinkClassName =
  "inline-flex min-h-11 items-center rounded-md px-2 text-muted-strong underline-offset-[3px] hover:text-ink hover:underline";

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <nav
        aria-label="Site pages"
        className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-2 gap-y-1 px-4 py-4 text-sm max-[560px]:px-2"
      >
        {footerLinks.map((link) => (
          <Link className={footerLinkClassName} href={link.href} key={link.href}>
            {link.label}
          </Link>
        ))}
        <a
          className={footerLinkClassName}
          href={publicNarrative.repositoryUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          Repository
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        <Link className={`${footerLinkClassName} ml-auto`} href={sitePages.admin}>
          Admin
        </Link>
      </nav>
    </footer>
  );
}
