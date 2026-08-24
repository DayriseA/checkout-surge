"use client";

import {
  type DashboardProjection,
  deriveOversoldUnits,
  type RunHistoryListItem,
} from "@checkout-surge/contracts";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { BackendRead } from "../lib/api";
import { formatInstantUtc } from "../lib/presentation/format";
import { publicFailureExplanation } from "../lib/presentation/public-vocabulary";
import {
  deriveFreshnessPresentationState,
  deriveInventoryOutcomeState,
  deriveLagPresentationState,
  deriveOutcomePresentationState,
  deriveRunErpOutcomeState,
  deriveSharedErpProtectionState,
  deriveSharedRuntimeState,
} from "../lib/presentation/run-presentation-state";
import {
  deriveWatchComposition,
  type WatchComposition,
} from "../lib/presentation/watch-composition";
import { neutralLinkButtonClassName, primaryButtonClassName } from "./control-styles";
import {
  ConsistencyLagPanel,
  InventoryDrainPanel,
  RecoveryStatusPanel,
  RequestSurgePanel,
  RunErpOutcomesPanel,
  RunOutcomesPanel,
  SystemStatusPanel,
} from "./dashboard-panels";
import { ErrorNotice } from "./error-notice";
import { GoldSignals } from "./gold-signals";
import { useDashboardProjections } from "./realtime/use-dashboard-projections";
import { useDashboardRecovery } from "./realtime/use-dashboard-recovery";
import { RunConclusion } from "./run-conclusion";
import { ScenarioStrip } from "./scenario-strip";
import { StatusPill } from "./status-pill";

const actionClassName = `inline-flex items-center ${primaryButtonClassName}`;
const secondaryActionClassName = `${neutralLinkButtonClassName} text-base`;

export function OperatorDashboard({
  initialRecovery,
  latestCompletedRun = { status: "available", data: null },
}: {
  initialRecovery: BackendRead<DashboardProjection>;
  latestCompletedRun?: BackendRead<RunHistoryListItem | null>;
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
    retainedTerminalRun,
    refresh,
    retryNow,
    notifyRealtimeDisconnected,
    notifyRealtimeReopened,
    applyProjection,
  } = useDashboardRecovery(initialRecovery, {
    preserveAvailableRecoveryOnFailure: true,
  });
  const firstOpenRef = useRef(true);
  const handleOpen = useCallback(() => {
    notifyRealtimeReopened();
    if (firstOpenRef.current) {
      firstOpenRef.current = false;
      if (initialRecovery.status === "loading") return;
    }
    void refresh();
  }, [initialRecovery.status, notifyRealtimeReopened, refresh]);
  const realtimeStatus = useDashboardProjections({
    onProjection: applyProjection,
    onOpen: handleOpen,
    onDisconnect: () => void notifyRealtimeDisconnected(),
  });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 2_000);
    return () => clearInterval(interval);
  }, []);
  const composition = deriveWatchComposition({
    recovery,
    retainedTerminalRun,
    latestCompletedRun,
    signalSamples,
    transportStatus: realtimeStatus,
    now,
  });
  return (
    <div className="grid grid-cols-12 gap-4">
      <div className="col-span-12 flex justify-end">
        <StatusPill status={deriveFreshnessPresentationState(composition.freshness)} />
      </div>
      <WatchNarrative composition={composition} onRetry={() => void retryNow()} />
      <TechnicalDetails
        composition={composition}
        hasSyncIssue={hasSyncIssue}
        isRefreshing={isRefreshing}
        isRetryScheduled={isRetryScheduled}
        onRetry={() => void retryNow()}
        realtimeStatus={realtimeStatus}
        retryAttempt={retryAttempt}
        retryDelayMs={retryDelayMs}
        syncIssue={syncIssue}
      />
    </div>
  );
}

export function WatchNarrative({
  composition,
  onRetry,
}: {
  composition: WatchComposition;
  onRetry?: () => void;
}) {
  switch (composition.phase) {
    case "checking":
    case "unavailable":
      return (
        <section className="col-span-12 rounded-lg border border-border bg-surface p-6">
          <ErrorNotice
            context="watch-read"
            {...(onRetry ? { onRetry } : {})}
            read={composition.panelRecovery}
          />
        </section>
      );
    case "idle":
      return <IdleNarrative latestCompletedRun={composition.latestCompletedRun} />;
    case "starting":
      return (
        <>
          <ScenarioStrip configSnapshot={composition.run.configSnapshot} />
          <NarrativeMessage eyebrow="Preparing the run" title="Setting up the flash sale">
            Preparing inventory and checkout traffic. Signal readings will appear when traffic
            begins.
          </NarrativeMessage>
        </>
      );
    case "active":
      return (
        <>
          <ScenarioStrip configSnapshot={composition.run.configSnapshot} />
          <NarrativeMessage eyebrow="What is happening now" title="The surge is under way">
            {composition.presentation.description}
          </NarrativeMessage>
          <Signals composition={composition} />
          <RunErpOutcomesPanel
            freshness={composition.freshness}
            presentation={deriveRunErpOutcomeState(composition.projection.erp, composition.run)}
            recovery={composition.panelRecovery}
          />
          <ConsistencyLagPanel
            freshness={composition.freshness}
            presentation={deriveLagPresentationState(
              composition.projection.consistencyLag?.pendingConfirmationCount ?? null,
              composition.projection.consistencyLag?.confirmedOrderCount ?? null,
              composition.run,
            )}
            recovery={composition.panelRecovery}
          />
        </>
      );
    case "draining":
      return (
        <>
          <ScenarioStrip configSnapshot={composition.run.configSnapshot} />
          <NarrativeMessage eyebrow="Traffic finished" title="Following the drain">
            New checkout traffic has stopped. Remaining reservations are moving through protected
            processing to final confirmation.
          </NarrativeMessage>
          <Signals composition={composition} />
          <RunOutcomesPanel
            freshness={composition.freshness}
            presentation={deriveOutcomePresentationState(
              composition.projection.businessOutcome,
              composition.run,
              composition.presentation,
            )}
            recovery={composition.panelRecovery}
          />
          <RunErpOutcomesPanel
            freshness={composition.freshness}
            presentation={deriveRunErpOutcomeState(composition.projection.erp, composition.run)}
            recovery={composition.panelRecovery}
          />
          <ConsistencyLagPanel
            freshness={composition.freshness}
            presentation={deriveLagPresentationState(
              composition.projection.consistencyLag?.pendingConfirmationCount ?? null,
              composition.projection.consistencyLag?.confirmedOrderCount ?? null,
              composition.run,
            )}
            recovery={composition.panelRecovery}
          />
        </>
      );
    case "completed":
    case "failed":
      return <TerminalNarrative composition={composition} />;
  }
}

function IdleNarrative({
  latestCompletedRun,
}: {
  latestCompletedRun: BackendRead<RunHistoryListItem | null>;
}) {
  const latest = latestCompletedRun.status === "available" ? latestCompletedRun.data : null;
  return (
    <section className="col-span-12 rounded-lg border border-border bg-surface p-6">
      <p className="m-0 text-xs font-bold uppercase text-muted">Ready when you are</p>
      <h2 className="m-0 mt-1 text-2xl font-bold leading-tight text-ink">Start a demo</h2>
      <p className="m-0 mt-3 max-w-[66ch] leading-6 text-muted">
        Choose a flash-sale scenario, then return here to follow it from setup through the final
        result.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link className={actionClassName} href="/">
          Start a demo
        </Link>
        {latest ? (
          <Link className={secondaryActionClassName} href={`/run-history/${latest.runId}`}>
            {durableResultLinkName(latest.presetName, latest.occurredAt)}
          </Link>
        ) : null}
      </div>
      {!latest ? (
        <p className="m-0 mt-4 text-sm text-muted">
          {latestCompletedRun.status === "available"
            ? "No completed runs yet"
            : "Latest completed run unavailable"}
        </p>
      ) : null}
    </section>
  );
}

function TerminalNarrative({
  composition,
}: {
  composition: Extract<WatchComposition, { phase: "completed" | "failed" }>;
}) {
  const failure =
    composition.run.status === "failed"
      ? publicFailureExplanation(composition.run.failureCategory)
      : null;
  const endedAt =
    composition.run.status === "completed" || composition.run.status === "failed"
      ? composition.run.finalizedAt
      : composition.run.startedAt;

  return (
    <>
      {failure ? (
        <NarrativeMessage eyebrow="Run failed" title="The run could not complete">
          {failure.explanation}
        </NarrativeMessage>
      ) : null}
      <RunConclusion
        result={composition.result}
        runStatus={composition.run.status}
        showReconciliationStatus
      />
      <ScenarioStrip configSnapshot={composition.run.configSnapshot} />
      <Signals composition={composition} />
      <section className="col-span-12 rounded-lg border border-border bg-surface p-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Durable result</p>
        <Link
          className={`${secondaryActionClassName} mt-3`}
          href={`/run-history/${composition.run.runId}`}
        >
          {durableResultLinkName(composition.run.presetName, endedAt)}
        </Link>
      </section>
    </>
  );
}

function Signals({
  composition,
}: {
  composition: WatchComposition & {
    phase: "active" | "draining" | "completed" | "failed";
    projection: DashboardProjection;
    run: NonNullable<DashboardProjection["currentRun"]>;
    signalSamples?: Parameters<typeof GoldSignals>[0]["liveSamples"];
  };
}) {
  const outcome = composition.projection.businessOutcome;
  const startingStock = composition.projection.inventory?.allocatedStock ?? null;
  const oversoldUnits =
    outcome && startingStock !== null
      ? deriveOversoldUnits({ reservedUnits: outcome.reservedUnits, startingStock })
      : null;
  return (
    <GoldSignals
      acceptedReservations={outcome?.acceptedReservations ?? null}
      arrivalSummary={composition.projection.requestArrivalSummary}
      failedOrders={outcome?.failedOrders ?? null}
      liveLag={composition.projection.consistencyLag}
      liveSamples={
        composition.phase === "active" || composition.phase === "draining"
          ? (composition.signalSamples ?? [])
          : []
      }
      oversoldUnits={oversoldUnits}
      retryingOrderCount={outcome?.retryingOrders ?? 0}
      runStatus={composition.run.status}
      startingStock={startingStock}
      terminalSummary={composition.projection.runSignalTimelineSummary}
    />
  );
}

function NarrativeMessage({
  children,
  eyebrow,
  title,
}: {
  children: ReactNode;
  eyebrow: string;
  title: string;
}) {
  return (
    <section className="col-span-12 rounded-lg border border-border bg-surface p-4">
      <p className="m-0 text-xs font-bold uppercase text-muted">{eyebrow}</p>
      <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">{title}</h2>
      <p className="m-0 mt-2 leading-6 text-muted-strong">{children}</p>
    </section>
  );
}

function TechnicalDetails({
  composition,
  hasSyncIssue,
  isRefreshing,
  isRetryScheduled,
  onRetry,
  realtimeStatus,
  retryAttempt,
  retryDelayMs,
  syncIssue,
}: {
  composition: WatchComposition;
  hasSyncIssue: boolean;
  isRefreshing: boolean;
  isRetryScheduled: boolean;
  onRetry: () => void;
  realtimeStatus: Parameters<typeof RecoveryStatusPanel>[0]["realtimeStatus"];
  retryAttempt: number;
  retryDelayMs: number | null;
  syncIssue: Extract<BackendRead<DashboardProjection>, { status: "unavailable" }> | null;
}) {
  const projection = "projection" in composition ? composition.projection : null;
  const run = projection?.currentRun ?? null;
  const outcome = projection?.businessOutcome ?? null;

  return (
    <details className="col-span-12 rounded-lg border border-border bg-surface px-4 py-3">
      <summary className="cursor-pointer font-semibold text-muted-strong">
        Technical details
      </summary>
      <div className="mt-4 grid grid-cols-12 gap-4">
        <RecoveryStatusPanel
          freshness={composition.freshness}
          fullWidth={!projection || !run}
          hasSyncIssue={hasSyncIssue}
          isRefreshing={isRefreshing}
          isRetryScheduled={isRetryScheduled}
          onRefresh={onRetry}
          presentation={composition.presentation}
          realtimeStatus={realtimeStatus}
          recovery={composition.panelRecovery}
          retryAttempt={retryAttempt}
          retryDelayMs={retryDelayMs}
          syncIssue={syncIssue}
        />
        {projection && run ? (
          <>
            <RequestSurgePanel
              freshness={composition.freshness}
              recovery={composition.panelRecovery}
            />
            <InventoryDrainPanel
              freshness={composition.freshness}
              presentation={deriveInventoryOutcomeState(
                projection.inventory,
                run,
                outcome?.reservedUnits ?? null,
              )}
              recovery={composition.panelRecovery}
            />
            {composition.phase === "starting" ||
            composition.phase === "completed" ||
            composition.phase === "failed" ? (
              <>
                <RunErpOutcomesPanel
                  freshness={composition.freshness}
                  presentation={deriveRunErpOutcomeState(projection.erp, run)}
                  recovery={composition.panelRecovery}
                />
                <ConsistencyLagPanel
                  freshness={composition.freshness}
                  presentation={deriveLagPresentationState(
                    projection.consistencyLag?.pendingConfirmationCount ?? null,
                    projection.consistencyLag?.confirmedOrderCount ?? null,
                    run,
                  )}
                  recovery={composition.panelRecovery}
                />
                <RunOutcomesPanel
                  freshness={composition.freshness}
                  presentation={deriveOutcomePresentationState(
                    outcome,
                    run,
                    composition.presentation,
                  )}
                  recovery={composition.panelRecovery}
                />
              </>
            ) : null}
            <SystemStatusPanel
              erpPresentation={deriveSharedErpProtectionState(
                projection.systemStatus?.erpProtection ?? null,
              )}
              presentation={deriveSharedRuntimeState(projection.systemStatus)}
              recovery={composition.panelRecovery}
            />
          </>
        ) : null}
      </div>
    </details>
  );
}

function durableResultLinkName(scenario: string, time: string): string {
  return `View the full result for ${scenario} (${formatInstantUtc(time) ?? time})`;
}
