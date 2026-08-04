import { OperatorDashboard } from "../components/operator-dashboard";
import { pendingDashboardRecovery } from "../lib/api";

export const dynamic = "force-dynamic";

export default function WatchPage() {
  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Live watch</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Follow the current flash-sale run: buyer traffic, inventory, order processing, and final
            outcomes.
          </p>
        </div>
      </header>
      <OperatorDashboard initialRecovery={pendingDashboardRecovery()} />
    </>
  );
}
