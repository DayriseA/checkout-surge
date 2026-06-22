import { OperatorDashboard } from "../components/operator-dashboard";
import { StatusPill } from "../components/status-pill";
import { getDashboardBackendSnapshot } from "../lib/api";

export default async function RunHistoryPage() {
  const snapshot = await getDashboardBackendSnapshot();

  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Run history</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Completed runs, terminal inventory, traffic summaries, and business outcomes.
          </p>
        </div>
        <StatusPill label="no data" tone="idle" />
      </header>
      <OperatorDashboard snapshot={snapshot} showHistoryPlaceholder />
    </>
  );
}
