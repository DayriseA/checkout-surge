import type { DashboardRecoveryResponse } from "@checkout-surge/contracts";
import type { BackendRead, DashboardBackendSnapshot } from "../lib/api";
import { StatusPill } from "./status-pill";

const panelClassName =
  "min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full";
const panelNarrowClassName = `${panelClassName} col-span-4`;
const panelWideClassName = `${panelClassName} col-span-8`;
const panelHeaderClassName = "mb-4 flex items-start justify-between gap-3";
const eyebrowClassName = "m-0 text-xs font-bold uppercase text-muted";
const panelTitleClassName = "m-0 mt-1 text-base font-bold leading-tight text-ink";
const emptyStateClassName = "m-0 leading-6 text-muted";
const factGridClassName = "m-0 grid grid-cols-3 gap-3 max-[560px]:grid-cols-2";
const wideFactGridClassName = "m-0 grid grid-cols-5 gap-3 max-[560px]:grid-cols-2";
const stackedFactGridClassName = "m-0 grid gap-3";
const factItemClassName = "min-w-0";
const factTermClassName = "mb-1 text-xs font-bold text-muted";
const factValueClassName = "m-0 [overflow-wrap:anywhere] text-base font-bold text-ink";
const controlButtonClassName =
  "min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTime(value: string | undefined): string {
  if (!value) {
    return "Not started";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className={emptyStateClassName}>{children}</p>;
}

function UnavailableState({ read }: { read: BackendRead<unknown> }) {
  if (read.status === "available") {
    return null;
  }

  return (
    <div className="grid gap-1 rounded-lg border border-[#f7b4ad] bg-danger-soft p-3 leading-6 text-danger">
      <strong>Unavailable</strong>
      <span>{read.reason}</span>
      {read.httpStatus ? <span>HTTP {read.httpStatus}</span> : null}
    </div>
  );
}

export function ApiStatusPanel({ snapshot }: { snapshot: DashboardBackendSnapshot }) {
  const liveness = snapshot.liveness.status === "available" ? snapshot.liveness.data : null;
  const readiness = snapshot.readiness.status === "available" ? snapshot.readiness.data : null;
  const status = readiness?.status ?? liveness?.status ?? "unavailable";

  return (
    <section className={panelWideClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>API gateway</p>
          <h2 className={panelTitleClassName}>Service readiness</h2>
        </div>
        <StatusPill label={status} tone={status} />
      </div>
      {snapshot.readiness.status === "available" ? (
        <div className="grid gap-2.5">
          {snapshot.readiness.data.checks.map((check) => (
            <div
              className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 border-t border-border pt-3"
              key={check.name}
            >
              <span>{check.name}</span>
              <StatusPill label={check.status} tone={check.status} />
              {check.message ? (
                <small className="col-span-full text-muted">{check.message}</small>
              ) : null}
            </div>
          ))}
          {snapshot.readiness.data.checks.length === 0 ? (
            <EmptyState>No dependency checks are exposed yet.</EmptyState>
          ) : null}
        </div>
      ) : (
        <UnavailableState read={snapshot.readiness} />
      )}
      <dl className={factGridClassName}>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Liveness</dt>
          <dd className={factValueClassName}>{liveness ? liveness.status : "unavailable"}</dd>
        </div>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Uptime</dt>
          <dd className={factValueClassName}>
            {liveness ? `${Math.round(liveness.uptimeSeconds)}s` : "n/a"}
          </dd>
        </div>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Read timestamp</dt>
          <dd className={factValueClassName}>
            {readiness ? formatTime(readiness.timestamp) : "n/a"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function RecoveryStatusPanel({
  recovery,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
}) {
  const run = recovery.status === "available" ? recovery.data.currentRun : null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Recovery</p>
          <h2 className={panelTitleClassName}>Latest backend snapshot</h2>
        </div>
        <StatusPill label={run?.status ?? "idle"} tone={run ? "pending" : "idle"} />
      </div>
      {recovery.status === "available" ? (
        <dl className={stackedFactGridClassName}>
          <div className={factItemClassName}>
            <dt className={factTermClassName}>Current run</dt>
            <dd className={factValueClassName}>{run ? run.presetName : "No active run"}</dd>
          </div>
          <div className={factItemClassName}>
            <dt className={factTermClassName}>Traffic</dt>
            <dd className={factValueClassName}>{run?.trafficStatus ?? "Not active"}</dd>
          </div>
          <div className={factItemClassName}>
            <dt className={factTermClassName}>Recovered at</dt>
            <dd className={factValueClassName}>{formatTime(recovery.data.recoveredAt)}</dd>
          </div>
        </dl>
      ) : (
        <UnavailableState read={recovery} />
      )}
    </section>
  );
}

export function LoadRunControlsPanel() {
  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Run controls</p>
          <h2 className={panelTitleClassName}>Preset traffic</h2>
        </div>
        <StatusPill label="idle" tone="idle" />
      </div>
      <div className="grid gap-2.5">
        <button className={controlButtonClassName} type="button" disabled>
          preview-1k
        </button>
        <button className={controlButtonClassName} type="button" disabled>
          surge-5k
        </button>
        <button className={controlButtonClassName} type="button" disabled>
          surge-10k
        </button>
      </div>
      <EmptyState>Traffic starts are not configured.</EmptyState>
    </section>
  );
}

export function InventoryDrainPanel({
  recovery,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
}) {
  const inventory = recovery.status === "available" ? recovery.data.inventory : null;
  const percentRemaining =
    inventory && inventory.allocatedStock > 0
      ? Math.round((inventory.remainingStock / inventory.allocatedStock) * 100)
      : 0;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Inventory drain</p>
          <h2 className={panelTitleClassName}>Stock hold path</h2>
        </div>
        <StatusPill label={inventory ? "active" : "no data"} tone={inventory ? "ok" : "idle"} />
      </div>
      {inventory ? (
        <>
          <meter
            aria-label="Remaining inventory"
            className="meter mb-4 block h-2 w-full rounded-full border-0 bg-surface-muted"
            max={100}
            min={0}
            value={percentRemaining}
          />
          <dl className={factGridClassName}>
            <div className={factItemClassName}>
              <dt className={factTermClassName}>Remaining</dt>
              <dd className={factValueClassName}>{formatNumber(inventory.remainingStock)}</dd>
            </div>
            <div className={factItemClassName}>
              <dt className={factTermClassName}>Reserved</dt>
              <dd className={factValueClassName}>{formatNumber(inventory.reservedStock)}</dd>
            </div>
            <div className={factItemClassName}>
              <dt className={factTermClassName}>Pending</dt>
              <dd className={factValueClassName}>
                {formatNumber(inventory.pendingPersistenceCount)}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <EmptyState>No inventory data.</EmptyState>
      )}
    </section>
  );
}

export function QueuePressurePanel({
  recovery,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
}) {
  const queue = recovery.status === "available" ? recovery.data.queue : null;

  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Queue pressure</p>
          <h2 className={panelTitleClassName}>orders:process</h2>
        </div>
        <StatusPill label={queue ? "active" : "no data"} tone={queue ? "ok" : "idle"} />
      </div>
      {queue ? (
        <dl className={factGridClassName}>
          <div className={factItemClassName}>
            <dt className={factTermClassName}>Depth</dt>
            <dd className={factValueClassName}>{formatNumber(queue.depth)}</dd>
          </div>
          <div className={factItemClassName}>
            <dt className={factTermClassName}>Updated</dt>
            <dd className={factValueClassName}>{formatTime(queue.updatedAt)}</dd>
          </div>
        </dl>
      ) : (
        <EmptyState>No queue data.</EmptyState>
      )}
    </section>
  );
}

export function ErpHealthPanel() {
  return (
    <section className={panelNarrowClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>ERP health</p>
          <h2 className={panelTitleClassName}>Downstream dependency</h2>
        </div>
        <StatusPill label="no data" tone="idle" />
      </div>
      <dl className={factGridClassName}>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Latency</dt>
          <dd className={factValueClassName}>n/a</dd>
        </div>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>TPS cap</dt>
          <dd className={factValueClassName}>n/a</dd>
        </div>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Outage</dt>
          <dd className={factValueClassName}>n/a</dd>
        </div>
      </dl>
      <EmptyState>No ERP health data.</EmptyState>
    </section>
  );
}

export function RunOutcomesPanel({
  recovery,
}: {
  recovery: BackendRead<DashboardRecoveryResponse>;
}) {
  const metricCount = recovery.status === "available" ? recovery.data.recentMetrics.length : 0;

  return (
    <section className={panelWideClassName}>
      <div className={panelHeaderClassName}>
        <div>
          <p className={eyebrowClassName}>Run outcomes</p>
          <h2 className={panelTitleClassName}>Reservation and confirmation summary</h2>
        </div>
        <StatusPill label="no data" tone="idle" />
      </div>
      <dl className={wideFactGridClassName}>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Accepted</dt>
          <dd className={factValueClassName}>0</dd>
        </div>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Sold out</dt>
          <dd className={factValueClassName}>0</dd>
        </div>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Queued</dt>
          <dd className={factValueClassName}>0</dd>
        </div>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Confirmed</dt>
          <dd className={factValueClassName}>0</dd>
        </div>
        <div className={factItemClassName}>
          <dt className={factTermClassName}>Metrics</dt>
          <dd className={factValueClassName}>{formatNumber(metricCount)}</dd>
        </div>
      </dl>
    </section>
  );
}
