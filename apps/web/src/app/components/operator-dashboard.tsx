"use client";

import type { DashboardProjection } from "@checkout-surge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BackendRead } from "../lib/api";
import { dashboardUpdateExpected, deriveFreshness } from "../lib/presentation/freshness";
import {
  deriveErpPresentationState,
  deriveInventoryOutcomeState,
  deriveLagPresentationState,
  deriveOutcomePresentationState,
  deriveQueuePresentationState,
  deriveRunPresentationState,
} from "../lib/presentation/run-presentation-state";
import {
  CompletionOutcomesPanel,
  ConsistencyLagPanel,
  ErpHealthPanel,
  InventoryDrainPanel,
  QueuePressurePanel,
  RecoveryStatusPanel,
  RequestSurgePanel,
  RunOutcomesPanel,
} from "./dashboard-panels";
import { useDashboardProjections } from "./realtime/use-dashboard-projections";
import { useDashboardRecovery } from "./realtime/use-dashboard-recovery";

export function OperatorDashboard({
  initialRecovery,
}: {
  initialRecovery: BackendRead<DashboardProjection>;
}) {
  const {
    recovery,
    isRefreshing,
    isRetryScheduled,
    retryAttempt,
    retryDelayMs,
    hasSyncIssue,
    syncIssue,
    liveProjectionCount,
    refresh,
    retryNow,
    applyProjection,
  } = useDashboardRecovery(initialRecovery, {
    preserveAvailableRecoveryOnFailure: true,
  });
  const firstOpenRef = useRef(true);
  const handleOpen = useCallback(() => {
    if (firstOpenRef.current) {
      firstOpenRef.current = false;
      if (initialRecovery.status === "loading") return;
    }
    void refresh();
  }, [initialRecovery.status, refresh]);
  const realtimeStatus = useDashboardProjections({
    onProjection: applyProjection,
    onOpen: handleOpen,
    onDisconnect: handleOpen,
  });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 2_000);
    return () => clearInterval(interval);
  }, []);
  const projection = recovery.status === "available" ? recovery.data : null;
  const run = projection?.currentRun ?? null;
  const runPresentation = deriveRunPresentationState(recovery, projection);
  const freshness = deriveFreshness({
    transportStatus: realtimeStatus,
    recoveredAt: projection?.recoveredAt ?? now.toISOString(),
    now,
    lifecycle: run?.status ?? null,
    updateExpected: projection ? dashboardUpdateExpected(projection) : false,
  });
  const outcome = projection?.businessOutcome ?? null;

  return (
    <div className="grid grid-cols-12 gap-4">
      <RecoveryStatusPanel
        recovery={recovery}
        isRefreshing={isRefreshing}
        isRetryScheduled={isRetryScheduled}
        retryAttempt={retryAttempt}
        retryDelayMs={retryDelayMs}
        hasSyncIssue={hasSyncIssue}
        syncIssue={syncIssue}
        presentation={runPresentation}
        {...(projection ? { freshness } : {})}
        realtimeStatus={realtimeStatus}
        liveProjectionCount={liveProjectionCount}
        onRefresh={() => {
          void retryNow();
        }}
      />
      <RequestSurgePanel
        recovery={recovery}
        freshness={freshness}
        liveProjectionCount={liveProjectionCount}
      />
      <InventoryDrainPanel
        recovery={recovery}
        freshness={freshness}
        presentation={deriveInventoryOutcomeState(
          projection?.inventory ?? null,
          run,
          outcome?.acceptedReservations,
        )}
      />
      <QueuePressurePanel
        recovery={recovery}
        freshness={freshness}
        presentation={deriveQueuePresentationState(projection?.queue ?? null, run)}
      />
      <ErpHealthPanel
        recovery={recovery}
        freshness={freshness}
        presentation={deriveErpPresentationState(projection?.erp ?? null)}
      />
      <ConsistencyLagPanel
        recovery={recovery}
        freshness={freshness}
        presentation={deriveLagPresentationState(
          projection?.consistencyLag?.pendingConfirmationCount ?? null,
          projection?.consistencyLag?.confirmedOrderCount ?? null,
          run,
        )}
      />
      <RunOutcomesPanel
        recovery={recovery}
        freshness={freshness}
        presentation={deriveOutcomePresentationState(outcome, run, runPresentation)}
      />
      <CompletionOutcomesPanel recovery={recovery} />
    </div>
  );
}
