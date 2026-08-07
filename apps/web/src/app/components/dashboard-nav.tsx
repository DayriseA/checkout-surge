"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { publicNarrative } from "../lib/presentation/public-vocabulary";

const dashboardNavItems = [
  { href: "/", label: "Demo" },
  { href: "/watch", label: "Watch" },
  { href: "/run-history", label: "Run history" },
  { href: "/about", label: "About" },
  { href: "/admin", label: "Admin" },
] as const;

const linkClassName =
  "rounded-lg px-2.5 py-2 text-sm font-semibold hover:bg-surface-muted hover:text-ink";

function isCurrentRoute(pathname: string, href: string) {
  return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
}

export function DashboardNav({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <nav
      className="flex flex-wrap justify-end gap-1 max-[900px]:justify-start"
      aria-label="Dashboard routes"
    >
      {dashboardNavItems.map((item) => {
        const isCurrent = isCurrentRoute(pathname, item.href);
        return (
          <Link
            aria-current={isCurrent ? "page" : undefined}
            className={`${linkClassName} ${isCurrent ? "bg-surface-muted text-ink underline underline-offset-4" : "text-muted-strong"}`}
            href={item.href}
            key={item.href}
          >
            {item.label}
          </Link>
        );
      })}
      <a
        className={`${linkClassName} text-muted-strong`}
        href={publicNarrative.repositoryUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        Repository
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      {children}
    </nav>
  );
}
