import {
  ApiStatusPanel,
  ErpHealthPanel,
  InventoryDrainPanel,
  LoadRunControlsPanel,
  QueuePressurePanel,
  RecoveryStatusPanel,
  RunOutcomesPanel,
} from "./components/dashboard-panels";
import { getDashboardBackendSnapshot } from "./lib/api";

export default async function DemoDashboardPage() {
  const snapshot = await getDashboardBackendSnapshot();

  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Demo dashboard</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Operational view of API readiness, recovery state, traffic controls, inventory, queue
            pressure, downstream health, and run outcomes.
          </p>
        </div>
      </header>
      <div className="grid grid-cols-12 gap-4">
        <ApiStatusPanel snapshot={snapshot} />
        <RecoveryStatusPanel recovery={snapshot.recovery} />
        <LoadRunControlsPanel />
        <InventoryDrainPanel recovery={snapshot.recovery} />
        <QueuePressurePanel recovery={snapshot.recovery} />
        <ErpHealthPanel />
        <RunOutcomesPanel recovery={snapshot.recovery} />
      </div>
    </>
  );
}
