"use client";

import type { DashboardProjection } from "@checkout-surge/contracts";
import { useCallback } from "react";
import type { BackendRead } from "../lib/api";
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
  const handleOpen = useCallback(() => {
    void refresh();
  }, [refresh]);
  const realtimeStatus = useDashboardProjections({
    onProjection: applyProjection,
    onOpen: handleOpen,
    onDisconnect: handleOpen,
  });
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
