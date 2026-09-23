"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { publicNarrative } from "../lib/presentation/public-vocabulary";

const dashboardNavItems = [
  { href: "/", label: "Overview" },
  { href: "/demo", label: "Demo" },
  { href: "/watch", label: "Watch" },
  { href: "/run-history", label: "Run history" },
  { href: "/admin", label: "Admin" },
] as const;

const linkClassName =
  "relative inline-flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium transition-colors min-[901px]:hover:text-white max-[900px]:hover:bg-surface-muted";
const currentLinkClassName =
  "text-white after:absolute after:inset-x-3 after:-bottom-[7px] after:h-[3px] after:rounded-full after:bg-signal max-[900px]:bg-surface-muted max-[900px]:text-ink max-[900px]:after:inset-x-auto max-[900px]:after:inset-y-2 max-[900px]:after:left-0 max-[900px]:after:h-auto max-[900px]:after:w-[3px]";
const otherLinkClassName = "text-white/70 max-[900px]:text-muted-strong";

function isCurrentRoute(pathname: string, href: string) {
  return pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
}

export function DashboardNav({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);
  const pathnameRef = useRef(pathname);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pathnameRef.current !== pathname) setOpen(false);
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!navigationRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [open]);

  return (
    <nav
      aria-label="Dashboard routes"
      className="relative flex items-center justify-end gap-1"
      ref={navigationRef}
    >
      <button
        aria-controls="dashboard-navigation-panel"
        aria-expanded={open}
        className="hidden min-h-11 rounded-lg border border-white/30 px-3.5 py-2 text-sm font-semibold text-white hover:bg-reservoir-raised focus-visible:outline-signal max-[900px]:block"
        onClick={() => setOpen((current) => !current)}
        ref={toggleRef}
        type="button"
      >
        Menu
      </button>
      <div
        className={`flex flex-wrap items-center justify-end gap-0.5 max-[900px]:absolute max-[900px]:right-0 max-[900px]:top-full max-[900px]:z-20 max-[900px]:mt-2 max-[900px]:min-w-52 max-[900px]:flex-col max-[900px]:flex-nowrap max-[900px]:items-stretch max-[900px]:justify-start max-[900px]:max-h-[calc(100dvh-5rem)] max-[900px]:overflow-y-auto max-[900px]:rounded-lg max-[900px]:border max-[900px]:border-border max-[900px]:bg-surface max-[900px]:p-2 max-[900px]:shadow-[0_18px_40px_-12px_rgb(13_27_42/0.35)] ${
          open ? "max-[900px]:flex" : "max-[900px]:hidden"
        }`}
        id="dashboard-navigation-panel"
      >
        {dashboardNavItems.map((item) => {
          const isCurrent = isCurrentRoute(pathname, item.href);
          return (
            <Link
              aria-current={isCurrent ? "page" : undefined}
              className={`${linkClassName} ${isCurrent ? currentLinkClassName : otherLinkClassName}`}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          );
        })}
        <a
          className={`${linkClassName} ${otherLinkClassName}`}
          href={publicNarrative.repositoryUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          Repository
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        {children}
      </div>
    </nav>
  );
}
