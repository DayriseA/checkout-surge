import {
  ApiStatusPanel,
  ErpHealthPanel,
  LoadRunControlsPanel,
  RecoveryStatusPanel,
} from "../components/dashboard-panels";
import { StatusPill } from "../components/status-pill";
import { getDashboardBackendSnapshot } from "../lib/api";

export default async function AdminPage() {
  const snapshot = await getDashboardBackendSnapshot();

  return (
    <>
      <header className="routeHeader">
        <div>
          <h1>Admin console</h1>
          <p>Protected operator controls and service state for supervised demo runs.</p>
        </div>
        <StatusPill label="access required" tone="pending" />
      </header>
      <div className="dashboardGrid">
        <ApiStatusPanel snapshot={snapshot} />
        <RecoveryStatusPanel recovery={snapshot.recovery} />
        <LoadRunControlsPanel />
        <ErpHealthPanel />
        <section className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Admin actions</p>
              <h2>Protected controls</h2>
            </div>
            <StatusPill label="disabled" tone="blocked" />
          </div>
          <ul className="stateList">
            <li>
              Reset active run <StatusPill label="not configured" tone="idle" />
            </li>
            <li>
              Save preset <StatusPill label="not configured" tone="idle" />
            </li>
            <li>
              ERP controls <StatusPill label="not configured" tone="idle" />
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
