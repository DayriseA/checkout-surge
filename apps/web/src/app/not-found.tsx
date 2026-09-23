import type { Metadata } from "next";
import Link from "next/link";
import { textLinkClassName } from "./components/control-styles";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <>
      <header className="mb-4">
        <h1 className="type-display m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none text-ink">
          Page not found
        </h1>
        <p className="mt-3 max-w-[66ch] leading-6 text-muted">
          We could not find this page or saved run report.
        </p>
      </header>
      <div className="flex flex-wrap gap-3">
        <Link className={textLinkClassName} href="/run-history">
          Back to run history
        </Link>
        <Link className={textLinkClassName} href="/">
          Go to the demo home
        </Link>
      </div>
    </>
  );
}
