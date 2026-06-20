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
      <header className="routeHeader">
        <div>
          <h1>Demo dashboard</h1>
          <p>
            Operational view of API readiness, recovery state, traffic controls, inventory, queue
            pressure, downstream health, and run outcomes.
          </p>
        </div>
      </header>
      <div className="dashboardGrid">
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
