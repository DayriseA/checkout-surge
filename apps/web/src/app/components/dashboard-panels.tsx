import type { DashboardRecoveryResponse } from "@checkout-surge/contracts";
import type { BackendRead, DashboardBackendSnapshot } from "../lib/api";
import { StatusPill } from "./status-pill";

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
  return <p className="emptyState">{children}</p>;
}

function UnavailableState({ read }: { read: BackendRead<unknown> }) {
  if (read.status === "available") {
    return null;
  }

  return (
    <div className="unavailableBox">
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
    <section className="panel panelWide">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">API gateway</p>
          <h2>Service readiness</h2>
        </div>
        <StatusPill label={status} tone={status} />
      </div>
      {snapshot.readiness.status === "available" ? (
        <div className="checkGrid">
          {snapshot.readiness.data.checks.map((check) => (
            <div className="checkItem" key={check.name}>
              <span>{check.name}</span>
              <StatusPill label={check.status} tone={check.status} />
              {check.message ? <small>{check.message}</small> : null}
            </div>
          ))}
          {snapshot.readiness.data.checks.length === 0 ? (
            <EmptyState>No dependency checks are exposed yet.</EmptyState>
          ) : null}
        </div>
      ) : (
        <UnavailableState read={snapshot.readiness} />
      )}
      <dl className="metaGrid">
        <div>
          <dt>Liveness</dt>
          <dd>{liveness ? liveness.status : "unavailable"}</dd>
        </div>
        <div>
          <dt>Uptime</dt>
          <dd>{liveness ? `${Math.round(liveness.uptimeSeconds)}s` : "n/a"}</dd>
        </div>
        <div>
          <dt>Read timestamp</dt>
          <dd>{readiness ? formatTime(readiness.timestamp) : "n/a"}</dd>
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
    <section className="panel">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Recovery</p>
          <h2>Latest backend snapshot</h2>
        </div>
        <StatusPill label={run?.status ?? "idle"} tone={run ? "pending" : "idle"} />
      </div>
      {recovery.status === "available" ? (
        <dl className="stackedFacts">
          <div>
            <dt>Current run</dt>
            <dd>{run ? run.presetName : "No active run"}</dd>
          </div>
          <div>
            <dt>Traffic</dt>
            <dd>{run?.trafficStatus ?? "Not active"}</dd>
          </div>
          <div>
            <dt>Recovered at</dt>
            <dd>{formatTime(recovery.data.recoveredAt)}</dd>
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
    <section className="panel">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Run controls</p>
          <h2>Preset traffic</h2>
        </div>
        <StatusPill label="idle" tone="idle" />
      </div>
      <div className="controlGrid">
        <button type="button" disabled>
          preview-1k
        </button>
        <button type="button" disabled>
          surge-5k
        </button>
        <button type="button" disabled>
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
    <section className="panel">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Inventory drain</p>
          <h2>Stock hold path</h2>
        </div>
        <StatusPill label={inventory ? "active" : "no data"} tone={inventory ? "ok" : "idle"} />
      </div>
      {inventory ? (
        <>
          <meter
            aria-label="Remaining inventory"
            className="meter"
            max={100}
            min={0}
            value={percentRemaining}
          />
          <dl className="metricRow">
            <div>
              <dt>Remaining</dt>
              <dd>{formatNumber(inventory.remainingStock)}</dd>
            </div>
            <div>
              <dt>Reserved</dt>
              <dd>{formatNumber(inventory.reservedStock)}</dd>
            </div>
            <div>
              <dt>Pending</dt>
              <dd>{formatNumber(inventory.pendingPersistenceCount)}</dd>
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
    <section className="panel">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Queue pressure</p>
          <h2>orders:process</h2>
        </div>
        <StatusPill label={queue ? "active" : "no data"} tone={queue ? "ok" : "idle"} />
      </div>
      {queue ? (
        <dl className="metricRow">
          <div>
            <dt>Depth</dt>
            <dd>{formatNumber(queue.depth)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatTime(queue.updatedAt)}</dd>
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
    <section className="panel">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">ERP health</p>
          <h2>Downstream dependency</h2>
        </div>
        <StatusPill label="no data" tone="idle" />
      </div>
      <dl className="metricRow">
        <div>
          <dt>Latency</dt>
          <dd>n/a</dd>
        </div>
        <div>
          <dt>TPS cap</dt>
          <dd>n/a</dd>
        </div>
        <div>
          <dt>Outage</dt>
          <dd>n/a</dd>
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
    <section className="panel panelWide">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">Run outcomes</p>
          <h2>Reservation and confirmation summary</h2>
        </div>
        <StatusPill label="no data" tone="idle" />
      </div>
      <dl className="metricRow metricRowFive">
        <div>
          <dt>Accepted</dt>
          <dd>0</dd>
        </div>
        <div>
          <dt>Sold out</dt>
          <dd>0</dd>
        </div>
        <div>
          <dt>Queued</dt>
          <dd>0</dd>
        </div>
        <div>
          <dt>Confirmed</dt>
          <dd>0</dd>
        </div>
        <div>
          <dt>Metrics</dt>
          <dd>{formatNumber(metricCount)}</dd>
        </div>
      </dl>
    </section>
  );
}
