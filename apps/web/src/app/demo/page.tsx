import type { Metadata } from "next";
import Link from "next/link";
import { textLinkClassName } from "../components/control-styles";
import { PublicDemoEntry } from "../components/public-demo-entry";
import { getPublicDemoSurface } from "../lib/api";
import { siteLink, sitePages } from "../lib/site-links";

export const metadata: Metadata = { title: "Demo" };
export const dynamic = "force-dynamic";

export default async function DemoDashboardPage() {
  const surface = await getPublicDemoSurface();
  return (
    <>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
        <h1 className="type-display m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none text-ink">
          Checkout-Surge demo
        </h1>
        <p className="m-0 max-w-[52ch] leading-6 text-muted">
          Choose a simulation, start it, and watch the system handle a release of buyers.
        </p>
      </header>
      <PublicDemoEntry surface={surface} />
      <section
        aria-labelledby="demo-mental-model"
        className="mt-5 grid grid-cols-[15rem_minmax(0,1fr)] gap-x-8 gap-y-2 px-5 py-2 max-[800px]:grid-cols-1 max-[560px]:px-0"
      >
        <h2 className="type-title m-0 text-lg leading-7 text-ink" id="demo-mental-model">
          How the surge stays safe
        </h2>
        <p className="m-0 max-w-[80ch] text-sm leading-6 text-muted-strong">
          Simulated buyers compete for limited stock: an in-memory store (Redis) decides each
          attempt in one step, so no unit is sold twice, and orders wait in a queue, so the slow,
          simulated back office is never flooded. The results describe this demo,{" "}
          <Link className={textLinkClassName} href={siteLink("limits", "scale")}>
            at its scale
          </Link>
          .
        </p>
        <Link
          className={`${textLinkClassName} text-sm min-[801px]:col-start-2`}
          href={sitePages.howItWorks}
        >
          How it works
        </Link>
      </section>
    </>
  );
}
