import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Checkout-Surge Dashboard",
  description: "Operational dashboard for Checkout-Surge.",
};

const navItems = [
  { href: "/", label: "Demo" },
  { href: "/watch", label: "Watch" },
  { href: "/admin", label: "Admin" },
  { href: "/run-history", label: "Run history" },
  { href: "/about", label: "About" },
] as const;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="appShell">
          <header className="topBar">
            <div className="topBarInner">
              <Link className="brand" href="/">
                <strong>Checkout-Surge</strong>
                <span>Dashboard</span>
              </Link>
              <nav className="navLinks" aria-label="Dashboard routes">
                {navItems.map((item) => (
                  <Link href={item.href} key={item.href}>
                    {item.label}
                  </Link>
                ))}
              </nav>
            </div>
          </header>
          <main className="mainContent">{children}</main>
        </div>
      </body>
    </html>
  );
}
