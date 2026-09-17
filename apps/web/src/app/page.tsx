import type { Metadata } from "next";
import Link from "next/link";
import { AdvancedOnly, PageView } from "./components/page-view";
import { PublicDemoEntry } from "./components/public-demo-entry";
import { getPublicDemoSurface } from "./lib/api";

export const metadata: Metadata = { title: { absolute: "Demo · Checkout-Surge" } };
export const dynamic = "force-dynamic";

export default async function DemoDashboardPage() {
  const surface = await getPublicDemoSurface();
  return (
    <PageView>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Checkout-Surge demo</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Choose a simulation, start it, and watch a simulated flash sale unfold.
          </p>
        </div>
      </header>
      <PublicDemoEntry surface={surface} />
      <AdvancedOnly>
        <section
          aria-labelledby="demo-mental-model"
          className="mt-4 rounded-lg border border-border bg-surface p-5"
        >
          <h2 className="m-0 text-xl font-bold text-ink" id="demo-mental-model">
            How the surge stays safe
          </h2>
          <p className="mt-3 max-w-[80ch] leading-7 text-muted-strong">
            Simulated buyers compete for limited stock. Redis atomically reserves units immediately
            without overselling, and orders for unique reservations wait in a BullMQ queue. Workers
            drain that queue at a safe rate while calling a deliberately slow simulated ERP; a run
            succeeds only when every unique reservation reaches a confirmed or failed outcome, no
            orders fail, and oversold units remain zero. Results depend on the environment and are
            not universal production evidence.
          </p>
          <Link className="mt-3 inline-block font-semibold text-accent underline" href="/about">
            How this works
          </Link>
        </section>
      </AdvancedOnly>
    </PageView>
  );
}
