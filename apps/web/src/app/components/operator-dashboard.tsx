"use client";

import type { DashboardProjection } from "@checkout-surge/contracts";
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
    syncIssue,
    liveProjectionCount,
    refresh,
    retryNow,
    applyProjection,
  } = useDashboardRecovery(snapshot.recovery, { preserveAvailableRecoveryOnFailure: true });
  const handleOpen = useCallback(() => {
    void refresh();
  }, [refresh]);
  const realtimeStatus = useDashboardEvents({
    onProjection: applyProjection,
    onOpen: handleOpen,
    onDisconnect: handleOpen,
  });
  const liveSnapshot = useMemo(() => ({ ...snapshot, recovery }), [snapshot, recovery]);
  const recentOrderStates = useMemo(
    () => (recovery.status === "available" ? recentOrderStatesForProjection(recovery.data) : []),
    [recovery],
  );

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
      <RecentOrderTransitionsPanel orders={recentOrderStates} />
      <RunOutcomesPanel recovery={recovery} />
      <CompletionOutcomesPanel recovery={recovery} />
    </div>
  );
}

function recentOrderStatesForProjection(projection: DashboardProjection) {
  return projection.recentCompletionOutcomes.flatMap((outcome) => {
    const occurredAt =
      outcome.orderStatus === "confirmed"
        ? outcome.confirmedAt
        : outcome.orderStatus === "failed"
          ? outcome.failedAt
          : outcome.orderStatus === "processing"
            ? outcome.processingAt
            : outcome.queuedAt;
    return occurredAt
      ? [
          {
            orderId: outcome.orderId,
            publicOrderId: outcome.publicOrderId,
            status: outcome.orderStatus,
            occurredAt,
          },
        ]
      : [];
  });
}
