import type { Metadata } from "next";
import Link from "next/link";
import { AdminSignOut } from "./components/admin-nav";
import { DashboardNav } from "./components/dashboard-nav";
import { hasValidAdminPageSession } from "./lib/server/admin-page-session";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    template: "%s · Checkout-Surge",
    default: "Checkout-Surge Dashboard",
  },
  description: "Operational dashboard for Checkout-Surge.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const authenticated = await hasValidAdminPageSession();
  return (
    <html className="scroll-pt-20" lang="en">
      <body className="min-h-screen bg-page font-sans text-[0.9375rem] leading-6 text-foreground antialiased">
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-30 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:font-semibold focus:text-ink"
          href="#main-content"
        >
          Skip to main content
        </a>
        <div className="min-h-screen">
          <header className="site-header sticky top-0 z-20 bg-reservoir text-white">
            <div className="mx-auto flex min-h-14 max-w-[1280px] items-center justify-between gap-5 px-6 max-[560px]:px-4">
              <Link className="flex items-center gap-2.5 rounded-md py-1" href="/">
                <BrandMark />
                <strong className="type-display text-[1.0625rem] leading-none tracking-normal">
                  Checkout-Surge
                </strong>
              </Link>
              <DashboardNav>{authenticated ? <AdminSignOut /> : null}</DashboardNav>
            </div>
          </header>
          <main
            className="mx-auto max-w-[1280px] scroll-mt-20 px-6 pb-16 pt-6 max-[560px]:px-4 max-[560px]:pt-4"
            id="main-content"
            tabIndex={-1}
          >
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

/** A surge of arrivals meeting one gate and leaving as a single steady line. */
function BrandMark() {
  return (
    <svg aria-hidden="true" className="size-6 shrink-0" viewBox="0 0 24 24">
      <g fill="currentColor" opacity="0.55">
        <circle cx="3" cy="6" r="1.6" />
        <circle cx="7" cy="9" r="1.6" />
        <circle cx="3" cy="12" r="1.6" />
        <circle cx="7" cy="15" r="1.6" />
        <circle cx="3" cy="18" r="1.6" />
      </g>
      <rect fill="var(--color-signal)" height="18" rx="1.5" width="3" x="11" y="3" />
      <g fill="currentColor">
        <circle cx="18" cy="12" r="1.6" />
        <circle cx="22.4" cy="12" r="1.6" />
      </g>
    </svg>
  );
}
