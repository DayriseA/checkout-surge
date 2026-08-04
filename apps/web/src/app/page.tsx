import { PublicDemoEntry } from "./components/public-demo-entry";
import { getPublicDemoSurface } from "./lib/api";

export const dynamic = "force-dynamic";

export default async function DemoDashboardPage() {
  const surface = await getPublicDemoSurface();

  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Checkout-Surge demo</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Start a flash-sale scenario, then watch buyer attempts, inventory, order processing,
            simulated ERP behavior, and the final result settle in real time.
          </p>
        </div>
      </header>
      <PublicDemoEntry surface={surface} />
    </>
  );
}
