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
  RecentOrderTransitionsPanel,
  RecoveryStatusPanel,
  RequestSurgePanel,
  RunOutcomesPanel,
} from "./dashboard-panels";
import { useDashboardEvents } from "./realtime/use-dashboard-events";
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
    liveEventCount,
    recentOrderStates,
    recentOrderLagSamples,
    refresh,
    retryNow,
    applyEvent,
  } = useDashboardRecovery(snapshot.recovery);
  const handleOpen = useCallback(() => {
    void refresh();
  }, [refresh]);
  const realtimeStatus = useDashboardEvents({ onEvent: applyEvent, onOpen: handleOpen });
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
        realtimeStatus={realtimeStatus}
        liveEventCount={liveEventCount}
        onRefresh={() => {
          void retryNow();
        }}
      />
      <RequestSurgePanel recovery={recovery} liveEventCount={liveEventCount} />
      <InventoryDrainPanel recovery={recovery} />
      <QueuePressurePanel recovery={recovery} />
      <ErpHealthPanel recovery={recovery} />
      <ConsistencyLagPanel recovery={recovery} latestOrderLag={recentOrderLagSamples.at(-1) ?? null} />
      <RecentOrderTransitionsPanel orders={recentOrderStates} />
      <RunOutcomesPanel recovery={recovery} />
      <CompletionOutcomesPanel recovery={recovery} />
    </div>
  );
}
