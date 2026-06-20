import { ApiStatusPanel, RunOutcomesPanel } from "../components/dashboard-panels";
import { StatusPill } from "../components/status-pill";
import { getDashboardBackendSnapshot } from "../lib/api";

export default async function RunHistoryPage() {
  const snapshot = await getDashboardBackendSnapshot();

  return (
    <>
      <header className="routeHeader">
        <div>
          <h1>Run history</h1>
          <p>Completed runs, terminal inventory, traffic summaries, and business outcomes.</p>
        </div>
        <StatusPill label="no data" tone="idle" />
      </header>
      <div className="dashboardGrid">
        <ApiStatusPanel snapshot={snapshot} />
        <RunOutcomesPanel recovery={snapshot.recovery} />
        <section className="panel panelWide">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Completed runs</p>
              <h2>Summary table</h2>
            </div>
            <StatusPill label="no data" tone="idle" />
          </div>
          <ul className="stateList">
            <li>
              Run ID <StatusPill label="n/a" tone="idle" />
            </li>
            <li>
              HTTP summary <StatusPill label="n/a" tone="idle" />
            </li>
            <li>
              Business outcome <StatusPill label="n/a" tone="idle" />
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
