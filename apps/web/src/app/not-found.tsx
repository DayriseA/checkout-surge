import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <>
      <header className="mb-4">
        <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Page not found</h1>
        <p className="mt-3 max-w-[66ch] leading-6 text-muted">
          We could not find this page or saved run report.
        </p>
      </header>
      <div className="flex flex-wrap gap-3">
        <Link className="font-semibold text-accent underline" href="/run-history">
          Back to run history
        </Link>
        <Link className="font-semibold text-accent underline" href="/">
          Go to the demo home
        </Link>
      </div>
    </>
  );
}
