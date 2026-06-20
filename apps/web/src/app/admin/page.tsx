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
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Admin console</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Protected operator controls and service state for supervised demo runs.
          </p>
        </div>
        <StatusPill label="access required" tone="pending" />
      </header>
      <div className="grid grid-cols-12 gap-4">
        <ApiStatusPanel snapshot={snapshot} />
        <RecoveryStatusPanel recovery={snapshot.recovery} />
        <LoadRunControlsPanel />
        <ErpHealthPanel />
        <section className="col-span-4 min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="m-0 text-xs font-bold uppercase text-muted">Admin actions</p>
              <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
                Protected controls
              </h2>
            </div>
            <StatusPill label="disabled" tone="blocked" />
          </div>
          <ul className="m-0 grid list-none gap-3 p-0">
            <li className="flex items-center justify-between border-t border-border pt-3 text-muted-strong">
              Reset active run <StatusPill label="not configured" tone="idle" />
            </li>
            <li className="flex items-center justify-between border-t border-border pt-3 text-muted-strong">
              Save preset <StatusPill label="not configured" tone="idle" />
            </li>
            <li className="flex items-center justify-between border-t border-border pt-3 text-muted-strong">
              ERP controls <StatusPill label="not configured" tone="idle" />
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
