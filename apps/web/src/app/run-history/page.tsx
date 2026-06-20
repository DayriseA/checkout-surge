import { ApiStatusPanel, RunOutcomesPanel } from "../components/dashboard-panels";
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
      <div className="grid grid-cols-12 gap-4">
        <ApiStatusPanel snapshot={snapshot} />
        <RunOutcomesPanel recovery={snapshot.recovery} />
        <section className="col-span-8 min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="m-0 text-xs font-bold uppercase text-muted">Completed runs</p>
              <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">Summary table</h2>
            </div>
            <StatusPill label="no data" tone="idle" />
          </div>
          <ul className="m-0 grid list-none gap-3 p-0">
            <li className="flex items-center justify-between border-t border-border pt-3 text-muted-strong">
              Run ID <StatusPill label="n/a" tone="idle" />
            </li>
            <li className="flex items-center justify-between border-t border-border pt-3 text-muted-strong">
              HTTP summary <StatusPill label="n/a" tone="idle" />
            </li>
            <li className="flex items-center justify-between border-t border-border pt-3 text-muted-strong">
              Business outcome <StatusPill label="n/a" tone="idle" />
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
