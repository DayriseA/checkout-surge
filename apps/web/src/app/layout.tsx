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
    <html lang="en">
      <body className="min-h-screen bg-page font-sans text-foreground">
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-20 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:font-semibold focus:text-ink"
          href="#main-content"
        >
          Skip to main content
        </a>
        <div className="min-h-screen">
          <header className="sticky top-0 z-10 border-b border-border bg-surface/90">
            <div className="mx-auto flex min-h-16 max-w-[1200px] items-center justify-between gap-5 px-6 max-[560px]:px-4">
              <Link className="grid gap-0.5" href="/">
                <strong className="text-base text-ink">Checkout-Surge</strong>
                <span className="text-xs font-semibold uppercase text-muted">Dashboard</span>
              </Link>
              <DashboardNav>{authenticated ? <AdminSignOut /> : null}</DashboardNav>
            </div>
          </header>
          <main
            className="mx-auto max-w-[1200px] scroll-mt-20 p-6 max-[560px]:p-4"
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
