import { OperatorDashboard } from "../components/operator-dashboard";
import { getDashboardBackendSnapshot } from "../lib/api";

export default async function WatchPage() {
  const snapshot = await getDashboardBackendSnapshot();

  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Live watch</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Current-run recovery, inventory, queue pressure, and outcome signals.
          </p>
        </div>
      </header>
      <OperatorDashboard snapshot={snapshot} />
    </>
  );
}
