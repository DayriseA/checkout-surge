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
  // Oversell is an authoritative invariant: it compares durable reserved units with the inventory
  // snapshot's starting stock. The derived signal timeline is a reservation-row visualization and
  // is deliberately not an input, so a missing snapshot leaves oversell unknown rather than zero.
  const oversellStartingStock = projection?.inventory?.allocatedStock ?? null;
  const oversoldUnits =
    outcome && oversellStartingStock !== null
      ? deriveOversoldUnits({
          reservedUnits: outcome.reservedUnits,
          startingStock: oversellStartingStock,
        })
      : null;

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
        onRefresh={() => {
          void retryNow();
        }}
      />
      {projection ? (
        <>
          <GoldSignals
            acceptedReservations={outcome?.acceptedReservations ?? null}
            arrivalSummary={projection.requestArrivalSummary}
            liveLag={projection.consistencyLag}
            liveSamples={signalSamples}
            oversoldUnits={oversoldUnits}
            retryingOrderCount={outcome?.retryingOrders ?? 0}
            runStatus={run?.status ?? null}
            startingStock={projection.inventory?.allocatedStock ?? null}
            terminalSummary={projection.runSignalTimelineSummary}
          />
          <RequestSurgePanel recovery={recovery} freshness={freshness} />
          <InventoryDrainPanel
            recovery={recovery}
            freshness={freshness}
            presentation={deriveInventoryOutcomeState(
              projection.inventory,
              run,
              outcome?.reservedUnits ?? null,
            )}
          />
          <RunErpOutcomesPanel
            recovery={recovery}
            freshness={freshness}
            presentation={deriveRunErpOutcomeState(projection.erp, run)}
          />
          <ConsistencyLagPanel
            recovery={recovery}
            freshness={freshness}
            presentation={deriveLagPresentationState(
              projection.consistencyLag?.pendingConfirmationCount ?? null,
              projection.consistencyLag?.confirmedOrderCount ?? null,
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
            presentation={deriveSharedRuntimeState(projection.systemStatus)}
            erpPresentation={deriveSharedErpProtectionState(
              projection.systemStatus?.erpProtection ?? null,
            )}
          />
        </>
      ) : null}
    </div>
  );
}
