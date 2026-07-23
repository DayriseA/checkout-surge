"use client";

import { useCallback, useMemo } from "react";
import type { DashboardBackendSnapshot } from "../lib/api";
import {
  ApiStatusPanel,
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

export interface OperatorDashboardProps {
  snapshot: DashboardBackendSnapshot;
}

export function OperatorDashboard({ snapshot }: OperatorDashboardProps) {
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
  } = useDashboardRecovery(snapshot.recovery, { preserveAvailableRecoveryOnFailure: true });
  const handleOpen = useCallback(() => {
    void refresh();
  }, [refresh]);
  const realtimeStatus = useDashboardProjections({
    onProjection: applyProjection,
    onOpen: handleOpen,
    onDisconnect: handleOpen,
  });
  const liveSnapshot = useMemo(() => ({ ...snapshot, recovery }), [snapshot, recovery]);
  return (
    <div className="grid grid-cols-12 gap-4">
      <ApiStatusPanel snapshot={liveSnapshot} />
      <RecoveryStatusPanel
        recovery={recovery}
        isRefreshing={isRefreshing}
        isRetryScheduled={isRetryScheduled}
        retryAttempt={retryAttempt}
        retryDelayMs={retryDelayMs}
        hasSyncIssue={hasSyncIssue}
        syncIssue={syncIssue}
        realtimeStatus={realtimeStatus}
        liveProjectionCount={liveProjectionCount}
        onRefresh={() => {
          void retryNow();
        }}
      />
      <RequestSurgePanel recovery={recovery} liveProjectionCount={liveProjectionCount} />
      <InventoryDrainPanel recovery={recovery} />
      <QueuePressurePanel recovery={recovery} />
      <ErpHealthPanel recovery={recovery} />
      <ConsistencyLagPanel recovery={recovery} />
      <RunOutcomesPanel recovery={recovery} />
      <CompletionOutcomesPanel recovery={recovery} />
    </div>
  );
}
