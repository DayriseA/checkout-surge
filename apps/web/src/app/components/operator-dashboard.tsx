"use client";

import {
  type DashboardProjection,
  deriveOversoldUnits,
  deriveRunResult,
} from "@checkout-surge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BackendRead } from "../lib/api";
import { dashboardUpdateExpected, deriveFreshness } from "../lib/presentation/freshness";
import {
  deriveInventoryOutcomeState,
  deriveLagPresentationState,
  deriveOutcomePresentationState,
  deriveRunErpOutcomeState,
  deriveRunPresentationState,
  deriveSharedErpProtectionState,
  deriveSharedRuntimeState,
} from "../lib/presentation/run-presentation-state";
import { evidenceFromDashboard } from "../lib/presentation/run-result-presentation";
import {
  ConsistencyLagPanel,
  InventoryDrainPanel,
  RecoveryStatusPanel,
  RequestSurgePanel,
  RunErpOutcomesPanel,
  RunOutcomesPanel,
  SystemStatusPanel,
} from "./dashboard-panels";
import { GoldSignals } from "./gold-signals";
import { useDashboardProjections } from "./realtime/use-dashboard-projections";
import { useDashboardRecovery } from "./realtime/use-dashboard-recovery";
import { RunConclusion } from "./run-conclusion";

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
    signalSamples,
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
  const result =
    projection && (run?.status === "completed" || run?.status === "failed")
      ? deriveRunResult(evidenceFromDashboard(projection))
      : null;
  const runPresentation = deriveRunPresentationState(recovery, projection, result);
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
      {result ? <RunConclusion result={result} runStatus={run?.status ?? "starting"} /> : null}
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
      <GoldSignals
        acceptedReservations={outcome?.acceptedReservations ?? 0}
        arrivalSummary={projection?.requestArrivalSummary ?? null}
        liveLag={projection?.consistencyLag ?? null}
        liveSamples={signalSamples}
        oversoldUnits={
          projection?.runSignalTimelineSummary || projection?.inventory
            ? deriveOversoldUnits({
                reservedUnits: outcome ? outcome.reservedUnits : 0,
                startingStock:
                  projection.runSignalTimelineSummary?.inventoryDrain.startingStock ??
                  projection.inventory?.allocatedStock ??
                  0,
              })
            : 0
        }
        retryingOrderCount={outcome?.retryingOrders ?? 0}
        startingStock={projection?.inventory?.allocatedStock ?? null}
        terminalSummary={projection?.runSignalTimelineSummary ?? null}
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
          outcome?.reservedUnits ?? null,
        )}
      />
      <RunErpOutcomesPanel
        recovery={recovery}
        freshness={freshness}
        presentation={deriveRunErpOutcomeState(projection?.erp ?? null)}
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
      <SystemStatusPanel
        recovery={recovery}
        presentation={deriveSharedRuntimeState(projection?.systemStatus ?? null)}
        erpPresentation={deriveSharedErpProtectionState(
          projection?.systemStatus?.erpProtection ?? null,
        )}
      />
    </div>
  );
}
