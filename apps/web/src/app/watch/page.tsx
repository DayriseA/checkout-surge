import {
  ApiStatusPanel,
  InventoryDrainPanel,
  QueuePressurePanel,
  RecoveryStatusPanel,
  RunOutcomesPanel,
} from "../components/dashboard-panels";
import { getDashboardBackendSnapshot } from "../lib/api";

export default async function WatchPage() {
  const snapshot = await getDashboardBackendSnapshot();

  return (
    <>
      <header className="routeHeader">
        <div>
          <h1>Live watch</h1>
          <p>Current-run recovery, inventory, queue pressure, and outcome signals.</p>
        </div>
      </header>
      <div className="dashboardGrid">
        <RecoveryStatusPanel recovery={snapshot.recovery} />
        <ApiStatusPanel snapshot={snapshot} />
        <InventoryDrainPanel recovery={snapshot.recovery} />
        <QueuePressurePanel recovery={snapshot.recovery} />
        <RunOutcomesPanel recovery={snapshot.recovery} />
      </div>
    </>
  );
}
