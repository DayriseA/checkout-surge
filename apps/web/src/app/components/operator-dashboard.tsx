"use client";

import {
  type DashboardEvent,
  type DashboardRecoveryResponse,
  dashboardEventSchema,
} from "@checkout-surge/contracts";
import { useEffect, useMemo, useState } from "react";
import type { BackendRead, DashboardBackendSnapshot } from "../lib/api";
import { dashboardEventsUrl } from "../lib/realtime";
import {
  ApiStatusPanel,
  ConsistencyLagPanel,
  ErpHealthPanel,
  InventoryDrainPanel,
  LoadRunControlsPanel,
  QueuePressurePanel,
  type RealtimeConnectionStatus,
  RecoveryStatusPanel,
  RequestSurgePanel,
  RunOutcomesPanel,
} from "./dashboard-panels";

interface OperatorDashboardProps {
  snapshot: DashboardBackendSnapshot;
  showControls?: boolean;
  showAdminActions?: boolean;
  showHistoryPlaceholder?: boolean;
}

export function OperatorDashboard({
  snapshot,
  showControls = false,
  showAdminActions = false,
  showHistoryPlaceholder = false,
}: OperatorDashboardProps) {
  const [recovery, setRecovery] = useState(snapshot.recovery);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeConnectionStatus>("connecting");
  const [liveEventCount, setLiveEventCount] = useState(0);

  useEffect(() => {
    setRecovery(snapshot.recovery);
  }, [snapshot.recovery]);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setRealtimeStatus("unsupported");
      return;
    }

    const source = new EventSource(dashboardEventsUrl());

    source.onopen = () => {
      setRealtimeStatus("connected");
    };
    source.onerror = () => {
      setRealtimeStatus("disconnected");
    };
    source.onmessage = (message) => {
      const payload = parseJson(message.data);

      if (!payload.ok) {
        return;
      }

      const parsed = dashboardEventSchema.safeParse(payload.value);

      if (!parsed.success) {
        return;
      }

      setLiveEventCount((count) => count + 1);
      setRecovery((current) => applyDashboardEvent(current, parsed.data));
    };

    return () => {
      source.close();
    };
  }, []);

  const liveSnapshot = useMemo(
    () => ({
      ...snapshot,
      recovery,
    }),
    [snapshot, recovery],
  );

  return (
    <div className="grid grid-cols-12 gap-4">
      <ApiStatusPanel snapshot={liveSnapshot} />
      <RecoveryStatusPanel
        recovery={recovery}
        realtimeStatus={realtimeStatus}
        liveEventCount={liveEventCount}
      />
      {showControls ? <LoadRunControlsPanel /> : null}
      <RequestSurgePanel recovery={recovery} liveEventCount={liveEventCount} />
      <InventoryDrainPanel recovery={recovery} />
      <QueuePressurePanel recovery={recovery} />
      <ErpHealthPanel recovery={recovery} />
      <ConsistencyLagPanel recovery={recovery} />
      <RunOutcomesPanel recovery={recovery} />
      {showAdminActions ? <AdminActionsPanel /> : null}
      {showHistoryPlaceholder ? <RunHistoryPlaceholder /> : null}
    </div>
  );
}

function parseJson(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

function applyDashboardEvent(
  recovery: BackendRead<DashboardRecoveryResponse>,
  event: DashboardEvent,
): BackendRead<DashboardRecoveryResponse> {
  if (recovery.status !== "available") {
    return recovery;
  }

  const current = recovery.data;

  switch (event.type) {
    case "run.started":
    case "run.updated":
    case "run.completed":
    case "run.failed":
      return {
        ...recovery,
        data: {
          ...current,
          currentRun: event.run,
          recoveredAt: event.occurredAt,
        },
      };
    case "inventory.updated":
      return {
        ...recovery,
        data: {
          ...current,
          inventory: event.inventory,
        },
      };
    case "queue.updated":
      return {
        ...recovery,
        data: {
          ...current,
          queue: event.queue,
        },
      };
    case "traffic.metric":
      return {
        ...recovery,
        data: {
          ...current,
          recentMetrics: [
            ...current.recentMetrics.slice(-19),
            {
              metricName: event.metricName,
              value: event.value,
              unit: event.unit,
              timestamp: event.occurredAt,
            },
          ],
        },
      };
    case "business.outcome.updated":
      return {
        ...recovery,
        data: {
          ...current,
          businessOutcome: event.outcome,
        },
      };
  }
}

function AdminActionsPanel() {
  return (
    <section className="col-span-4 min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase text-muted">Admin actions</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            Protected controls
          </h2>
        </div>
      </div>
      <ul className="m-0 grid list-none gap-3 p-0">
        <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
          <span>Reset active run</span>
          <span className="font-semibold text-muted">not configured</span>
        </li>
        <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
          <span>Save preset</span>
          <span className="font-semibold text-muted">not configured</span>
        </li>
        <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
          <span>ERP controls</span>
          <span className="font-semibold text-muted">not configured</span>
        </li>
      </ul>
    </section>
  );
}

function RunHistoryPlaceholder() {
  return (
    <section className="col-span-8 min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase text-muted">Completed runs</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">Summary table</h2>
        </div>
      </div>
      <ul className="m-0 grid list-none gap-3 p-0">
        <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
          <span>Run ID</span>
          <span className="font-semibold text-muted">n/a</span>
        </li>
        <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
          <span>HTTP summary</span>
          <span className="font-semibold text-muted">n/a</span>
        </li>
        <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
          <span>Business outcome</span>
          <span className="font-semibold text-muted">n/a</span>
        </li>
      </ul>
    </section>
  );
}
