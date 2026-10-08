import type { Metadata } from "next";
import Link from "next/link";
import { textLinkClassName } from "../components/control-styles";
import { PublicDemoEntry } from "../components/public-demo-entry";
import { getPublicDemoSurface } from "../lib/api";

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
          Simulated buyers, released as if by a waiting room, compete for limited stock. Redis
          decides each attempt atomically without overselling: buyers turned away are answered from
          Redis alone, and for each buyer who secures a unit, the reservation and order are written
          to PostgreSQL before the answer. Orders wait in a BullMQ queue, and workers drain it at a
          safe rate while calling a deliberately slow simulated ERP. A run succeeds only when every
          order is confirmed and none failed, and oversold units remain zero. Results depend on the
          environment and are not universal production evidence.
        </p>
        <Link
          className={`${textLinkClassName} text-sm min-[801px]:col-start-2`}
          href="/#waiting-room"
        >
          How this works
        </Link>
      </section>
    </>
  );
}
