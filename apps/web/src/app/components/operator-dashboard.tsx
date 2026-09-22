"use client";

import {
  type DashboardProjection,
  type DemoRunSnapshot,
  deriveOversoldUnits,
  type RunHistoryListItem,
} from "@checkout-surge/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BackendRead } from "../lib/api";
import type {
  AcceptedRunReportEvidence,
  AcceptedRunResult,
} from "../lib/presentation/accepted-run-result";
import { formatCount, formatDurationMs, formatInstantUtc } from "../lib/presentation/format";
import {
  derivePublicRunSummary,
  type PublicRunSummary,
} from "../lib/presentation/public-run-summary";
import { publicFailureExplanation } from "../lib/presentation/public-vocabulary";
import { deriveRunConfigFacts } from "../lib/presentation/run-config-presentation";
import {
  deriveFreshnessPresentationState,
  deriveInventoryOutcomeState,
  deriveLagPresentationState,
  deriveOutcomePresentationState,
  deriveRunErpOutcomeState,
} from "../lib/presentation/run-presentation-state";
import {
  deriveWatchComposition,
  type WatchComposition,
} from "../lib/presentation/watch-composition";
import { neutralLinkButtonClassName, primaryButtonClassName } from "./control-styles";
import {
  ConsistencyLagPanel,
  FreshnessLine,
  InventoryDrainPanel,
  RealtimeRecoveryNotice,
  RecoveryStatusPanel,
  RequestSurgePanel,
  RunErpOutcomesPanel,
  RunOutcomesPanel,
  SystemStatusPanel,
} from "./dashboard-panels";
import { ErrorNotice } from "./error-notice";
import { deriveGoldSignalCharts, type GoldSignalInput, GoldSignals } from "./gold-signals";
import { GracePeriodNotice } from "./grace-period-notice";
import { LiveTechnicalBoard } from "./live-technical-board";
import { useAcceptedRunResult } from "./realtime/use-accepted-run-result";
import { useDashboardProjections } from "./realtime/use-dashboard-projections";
import { useDashboardRecovery } from "./realtime/use-dashboard-recovery";
import { PublicRunCaveatList, PublicRunConclusionProof } from "./run-conclusion";
import { ScenarioStrip } from "./scenario-strip";
import { StatusPill } from "./status-pill";
import { deriveTransportObservation } from "./transport-observation";
import { WatchSignalStrip } from "./watch-signal-strip";

const actionClassName = `inline-flex items-center ${primaryButtonClassName}`;
const secondaryActionClassName = `${neutralLinkButtonClassName} text-base`;
const tileClassName = "min-w-0 rounded-lg border border-border bg-surface-muted p-2";
const tileValueClassName = "m-0 text-2xl font-bold leading-tight text-ink";
const tileLabelClassName = "m-0 text-xs font-bold text-muted";

export function OperatorDashboard({
  acceptedResult,
  initialRecovery,
  invalidAcceptedRunContext = false,
  latestCompletedRun = { status: "available", data: null },
}: {
  acceptedResult?: AcceptedRunResult;
  initialRecovery: BackendRead<DashboardProjection>;
  invalidAcceptedRunContext?: boolean;
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
  const incompleteRunId = recovery.status === "available" ? recovery.data.resetRecoveryRunId : null;
  const [resetRunId, setResetRunId] = useState(incompleteRunId);
  const currentRunId =
    recovery.status === "available" ? recovery.data.currentRun?.runId : undefined;
  useEffect(() => {
    if (incompleteRunId) setResetRunId(incompleteRunId);
    else if (currentRunId)
      setResetRunId((previous) => (previous === currentRunId ? previous : null));
  }, [incompleteRunId, currentRunId]);
  const resultContext =
    acceptedResult ?? (resetRunId ? { status: "awaiting" as const, runId: resetRunId } : undefined);
  const accepted = useAcceptedRunResult(resultContext);
  const firstOpenRef = useRef(true);
  const handleOpen = useCallback(() => {
    notifyRealtimeReopened();
    if (firstOpenRef.current) {
      firstOpenRef.current = false;
      if (initialRecovery.status === "loading") return;
    }
    void refresh();
  }, [initialRecovery.status, notifyRealtimeReopened, refresh]);
  const { status: realtimeStatus, reconnectExhausted } = useDashboardProjections({
    onProjection: applyProjection,
    onOpen: handleOpen,
    onDisconnect: () => void notifyRealtimeDisconnected(),
  });
  const [now, setNow] = useState(() => new Date());
  const technicalDetailsRef = useRef<HTMLDetailsElement>(null);
  const revealTechnicalDetails = useCallback((targetId: string) => {
    if (technicalDetailsRef.current) technicalDetailsRef.current.open = true;
    requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start", behavior: "instant" });
    });
  }, []);
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 2_000);
    return () => clearInterval(interval);
  }, []);
  const composition = deriveWatchComposition({
    recovery,
    retainedTerminalRun:
      resetRunId && retainedTerminalRun?.runId !== resetRunId ? null : retainedTerminalRun,
    latestCompletedRun,
    signalSamples,
    transportStatus: realtimeStatus,
    now,
  });
  const liveRun = "run" in composition ? composition.run : null;
  const trackedResult = accepted.result;
  const sameRunAccepted = Boolean(
    trackedResult && liveRun && trackedResult.runId === liveRun.runId,
  );
  // The saved-report delivery qualification exists only in the visitor's own already-read public
  // detail; it joins the shared verdict only when the accepted run is the run on screen.
  const savedEvidence: AcceptedRunReportEvidence | null =
    trackedResult?.status === "available" && sameRunAccepted
      ? (trackedResult.reportEvidence ?? null)
      : null;
  return (
    <div className="grid grid-cols-12 gap-4">
      {invalidAcceptedRunContext ? <InvalidAcceptedRunContext /> : null}
      {trackedResult && !sameRunAccepted ? (
        <AcceptedResultNarrative
          onRetry={() => void accepted.retryNow()}
          operatorReset={acceptedResult === undefined}
          result={trackedResult}
          retriesExhausted={accepted.retriesExhausted}
        />
      ) : null}
      <WatchNarrative
        accepted={
          trackedResult
            ? { retriesExhausted: accepted.retriesExhausted, result: trackedResult }
            : null
        }
        composition={composition}
        now={() => now.getTime()}
        onAcceptedRetry={() => void accepted.retryNow()}
        onRetry={() => void retryNow()}
        onRevealTechnicalDetails={revealTechnicalDetails}
        savedEvidence={savedEvidence}
        sharedDemo={Boolean(trackedResult && !sameRunAccepted)}
      />
      <div className="col-span-12">
        <SyncNotice
          composition={composition}
          hasSyncIssue={hasSyncIssue}
          isRefreshing={isRefreshing}
          isRetryScheduled={isRetryScheduled}
          onRetry={() => void retryNow()}
          retryAttempt={retryAttempt}
          retryDelayMs={retryDelayMs}
          syncIssue={syncIssue}
        />
      </div>
      <RealtimeRecoveryNotice
        className="col-span-12"
        realtimeStatus={realtimeStatus}
        reconnectExhausted={reconnectExhausted}
      />
      <TechnicalGroups
        acceptedResult={trackedResult}
        composition={composition}
        detailsRef={technicalDetailsRef}
        hasSyncIssue={hasSyncIssue}
        isRefreshing={isRefreshing}
        onRetry={() => void retryNow()}
        realtimeStatus={realtimeStatus}
        stoppedRun={acceptedResult === undefined}
        syncIssue={syncIssue}
      />
    </div>
  );
}

type TrackedAcceptedResult = { retriesExhausted: boolean; result: AcceptedRunResult };

type RunWatchComposition = Extract<
  WatchComposition,
  { phase: "starting" | "active" | "draining" | "completed" | "failed" }
>;

const phaseStepNames = ["Preparing", "Buyers arriving", "Confirming orders", "Result"] as const;

const phaseSteps: Record<RunWatchComposition["phase"], number> = {
  active: 1,
  completed: 3,
  draining: 2,
  failed: 3,
  starting: 0,
};

export function WatchNarrative({
  accepted = null,
  composition,
  now,
  onAcceptedRetry,
  onRetry,
  onRevealTechnicalDetails = () => undefined,
  savedEvidence = null,
  sharedDemo = false,
}: {
  accepted?: TrackedAcceptedResult | null;
  composition: WatchComposition;
  now?: (() => number) | undefined;
  onAcceptedRetry?: () => void;
  onRetry?: () => void;
  onRevealTechnicalDetails?: (targetId: string) => void;
  savedEvidence?: AcceptedRunReportEvidence | null;
  sharedDemo?: boolean;
}) {
  switch (composition.phase) {
    case "reset-recovery":
      return (
        <section className="col-span-12 rounded-lg border border-border bg-surface p-6">
          <h2>Operator stop recovery</h2>
          <p>
            The operator stop decision is recorded. Work cleanup and history are incomplete, so this
            report is unavailable. Worker work may still settle. New runs remain unavailable until
            recovery completes.
          </p>
        </section>
      );
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
      return <IdleNarrative />;
    case "starting":
    case "active":
    case "draining":
    case "completed":
    case "failed":
      return (
        <RunCard
          accepted={accepted}
          composition={composition}
          now={now}
          onAcceptedRetry={onAcceptedRetry}
          onRevealTechnicalDetails={onRevealTechnicalDetails}
          savedEvidence={savedEvidence}
          sharedDemo={sharedDemo}
        />
      );
  }
}

/**
 * The five-band compact Watch layout for every run phase: identity line, verdict line, counts row,
 * signal strip, caveat and actions. Technical proof and panels render outside this card.
 */
function RunCard({
  accepted,
  composition,
  now,
  onAcceptedRetry,
  onRevealTechnicalDetails,
  savedEvidence,
  sharedDemo,
}: {
  accepted: TrackedAcceptedResult | null;
  composition: RunWatchComposition;
  now?: (() => number) | undefined;
  onAcceptedRetry?: (() => void) | undefined;
  onRevealTechnicalDetails: (targetId: string) => void;
  savedEvidence: AcceptedRunReportEvidence | null;
  sharedDemo: boolean;
}) {
  const projection = composition.projection;
  const outcome = projection.businessOutcome;
  const inventory = projection.inventory;
  const terminal = composition.phase === "completed" || composition.phase === "failed";
  const summary = terminal ? terminalSummary(composition, savedEvidence) : null;
  const failure =
    terminal && composition.run.status === "failed"
      ? publicFailureExplanation(composition.run.failureCategory)
      : null;
  const counts = {
    awaiting: summary
      ? summary.counts.pendingOrders
      : outcome
        ? outcome.queuedOrders + outcome.processingOrders
        : null,
    confirmed: summary ? summary.counts.confirmedOrders : (outcome?.confirmedOrders ?? null),
    failed: summary ? summary.counts.failedOrders : (outcome?.failedOrders ?? null),
    // A progress bar needs one coherent same-run population with a known denominator: unique
    // reservations against confirmed orders once traffic has finished (draining/terminal).
    // During active traffic the reservation total still moves, so no bar is shown.
    progressDenominator: summary
      ? summary.counts.uniqueReservations
      : composition.phase === "draining"
        ? (outcome?.acceptedReservations ?? null)
        : null,
    remainingStock: summary ? summary.counts.remainingStock : (inventory?.remainingStock ?? null),
    reserved: summary ? summary.counts.reservedUnits : (inventory?.reservedStock ?? null),
  };
  const reportState = terminal ? terminalReportState(accepted, composition.run.runId) : null;
  const stripCharts = deriveGoldSignalCharts(goldSignalInput(composition));
  return (
    <section
      aria-label={terminal ? "Run conclusion" : undefined}
      className="col-span-12 grid gap-2 rounded-lg border border-border bg-surface p-2"
    >
      <IdentityLine composition={composition} sharedDemo={sharedDemo} />
      <div>
        <p className="m-0 text-xs font-bold uppercase text-muted">
          {terminal ? "Final result" : "In progress"}
        </p>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="m-0 text-xl font-bold leading-tight text-ink">
            {terminal ? summary?.title : runPhaseTitle(composition.phase)}
          </h2>
          <p className="m-0 text-sm leading-6 text-muted-strong">
            {terminal ? summary?.sentence : runPhaseSentence(composition)}
          </p>
        </div>
        {failure ? (
          <p className="m-0 mt-2 max-w-[66ch] text-sm leading-6 text-muted-strong">
            <span className="font-semibold">{failure.explanation}</span> {failure.action}
          </p>
        ) : null}
      </div>
      <GracePeriodNotice now={now} run={composition.run} />
      <CountsRow {...counts} liveOutcome={terminal ? undefined : outcome} />
      <WatchSignalStrip
        charts={stripCharts.charts}
        hasEvidence={stripCharts.hasEvidence}
        headlines={stripCharts.headlines}
        onReveal={onRevealTechnicalDetails}
      />
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 min-[900px]:flex-nowrap">
        <div className="grid min-w-0 flex-1 gap-2 [&>p]:mt-0">
          {summary && summary.caveats.length > 0 ? (
            <PublicRunCaveatList caveats={summary.caveats} />
          ) : null}
          {reportState === "preparing" ? (
            <p className="m-0 text-sm text-muted" role="status">
              Preparing saved report…
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 min-[900px]:shrink-0">
          {reportState === "link" ? (
            <Link className={actionClassName} href={`/run-history/${composition.run.runId}`}>
              View run report
            </Link>
          ) : null}
          {reportState === "retry" && onAcceptedRetry ? (
            <button className={secondaryActionClassName} onClick={onAcceptedRetry} type="button">
              Check again
            </button>
          ) : null}
          {terminal ? (
            <Link className={secondaryActionClassName} href="/demo">
              Try another scenario
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function terminalSummary(
  composition: Extract<WatchComposition, { phase: "completed" | "failed" }>,
  savedEvidence: AcceptedRunReportEvidence | null,
): PublicRunSummary {
  const transportObservation = savedEvidence
    ? deriveTransportObservation(
        savedEvidence.transportAttemptCounts,
        savedEvidence.transportFailures,
      )
    : composition.projection.transportAttemptCounts && composition.projection.httpSummary
      ? deriveTransportObservation(
          composition.projection.transportAttemptCounts,
          composition.projection.httpSummary.transportFailures,
        )
      : null;
  return derivePublicRunSummary({
    result: composition.result,
    trafficDeliveryStatus: savedEvidence?.trafficDeliveryStatus ?? null,
    transportObservation,
  });
}

/** One outcome summary and one report action for the run on screen. */
function terminalReportState(
  accepted: TrackedAcceptedResult | null,
  runId: string,
): "link" | "preparing" | "retry" {
  if (!accepted || accepted.result.runId !== runId) return "link";
  if (accepted.result.status === "available") return "link";
  if (accepted.result.status === "awaiting") return "preparing";
  return accepted.retriesExhausted ? "retry" : "preparing";
}

function runPhaseTitle(
  phase: Exclude<RunWatchComposition["phase"], "completed" | "failed">,
): string {
  switch (phase) {
    case "active":
      return "The surge is under way";
    case "draining":
      return "Confirming remaining orders";
    case "starting":
      return "Preparing the flash sale";
  }
}

function runPhaseSentence(
  composition: Exclude<RunWatchComposition, { phase: "completed" | "failed" }>,
): string {
  switch (composition.phase) {
    case "active":
      return composition.presentation.description;
    case "draining":
      return "New checkout traffic has stopped. Remaining reservations are moving through protected processing to final confirmation.";
    case "starting":
      return "Preparing inventory and checkout traffic. Signal readings will appear when traffic begins.";
  }
}

function IdentityLine({
  composition,
  sharedDemo,
}: {
  composition: RunWatchComposition;
  sharedDemo: boolean;
}) {
  const facts = deriveRunConfigFacts(composition.run.configSnapshot);
  const step = phaseSteps[composition.phase];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="m-0 text-sm font-semibold text-muted-strong">
        {composition.run.presetName} · {facts.surgeValue}{" "}
        {facts.surgeLabel === "Buyers" ? "buyers" : "attempts"} · {facts.startingStock} units
        {sharedDemo ? " · Now running in the shared demo" : ""}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <ol aria-label="Run phase" className="m-0 flex list-none items-center gap-1 p-0 text-xs">
          {phaseStepNames.map((name, index) => (
            <li className="flex items-center gap-1" key={name}>
              {index > 0 ? (
                <span aria-hidden="true" className="text-muted">
                  →
                </span>
              ) : null}
              <span
                aria-current={index === step ? "step" : undefined}
                className={index === step ? "font-bold text-ink" : "text-muted"}
              >
                {name}
              </span>
            </li>
          ))}
        </ol>
        <StatusPill status={deriveFreshnessPresentationState(composition.freshness)} />
      </div>
    </div>
  );
}

function CountsRow({
  awaiting,
  confirmed,
  failed,
  liveOutcome,
  progressDenominator,
  remainingStock,
  reserved,
}: {
  awaiting: number | null;
  confirmed: number | null;
  failed: number | null;
  liveOutcome: DashboardProjection["businessOutcome"] | undefined;
  progressDenominator: number | null;
  remainingStock: number | null;
  reserved: number | null;
}) {
  const format = (value: number | null): string => formatCount(value) ?? "—";
  // A coherent same-run population only: contradictory counts (confirmed above the known
  // reservation total) still render, but never as a filled progress bar.
  const progress =
    progressDenominator !== null &&
    progressDenominator > 0 &&
    confirmed !== null &&
    confirmed <= progressDenominator;
  return (
    <div
      className={`grid ${liveOutcome === undefined ? "grid-cols-4" : "grid-cols-5"} gap-3 max-[700px]:grid-cols-2`}
    >
      <div className={tileClassName}>
        <p className={tileValueClassName}>{format(remainingStock)}</p>
        <p className={tileLabelClassName}>Units left</p>
        {reserved !== null ? (
          <p className="m-0 mt-1 text-xs text-muted">{format(reserved)} reserved</p>
        ) : null}
      </div>
      <div className={tileClassName}>
        <p className={tileValueClassName}>{format(confirmed)}</p>
        <p className={tileLabelClassName}>Orders confirmed</p>
        {progress ? (
          <meter
            aria-label={`${format(confirmed)} of ${format(progressDenominator)} orders confirmed`}
            className="meter mt-2 block h-2 w-full rounded-full border-0 bg-surface"
            max={progressDenominator}
            value={confirmed}
          />
        ) : null}
      </div>
      <div className={tileClassName}>
        <p className={tileValueClassName}>{format(awaiting)}</p>
        <p className={tileLabelClassName}>Awaiting confirmation</p>
      </div>
      {liveOutcome === undefined ? (
        <div className={tileClassName}>
          <p className={tileValueClassName}>{format(failed)}</p>
          <p className={tileLabelClassName}>Orders failed</p>
        </div>
      ) : (
        <>
          <div className={tileClassName}>
            <p className={tileValueClassName}>
              {format(liveOutcome?.businessRejectedOrders ?? null)}
            </p>
            <p className={tileLabelClassName}>Business-rejected orders</p>
          </div>
          <div className={tileClassName}>
            <p className={tileValueClassName}>
              {format(liveOutcome?.technicallyFailedOrders ?? null)}
            </p>
            <p className={tileLabelClassName}>Technically failed orders</p>
          </div>
        </>
      )}
    </div>
  );
}

/** The evidence selection shared verbatim by the summary strip and full technical charts. */
function goldSignalInput(composition: RunWatchComposition): GoldSignalInput {
  const outcome = composition.projection.businessOutcome;
  const startingStock = composition.projection.inventory?.allocatedStock ?? null;
  const oversoldUnits =
    outcome && startingStock !== null
      ? deriveOversoldUnits({ reservedUnits: outcome.reservedUnits, startingStock })
      : null;
  return {
    acceptedReservations: outcome?.acceptedReservations ?? null,
    arrivalSummary: composition.projection.requestArrivalSummary,
    failedOrders: outcome?.failedOrders ?? null,
    liveLag: composition.projection.consistencyLag,
    liveSamples:
      composition.phase === "active" || composition.phase === "draining"
        ? (composition.signalSamples ?? [])
        : [],
    oversoldUnits,
    retryingOrderCount: outcome?.retryingOrders ?? 0,
    runStatus: composition.run.status,
    startingStock,
    terminalSummary: composition.projection.runSignalTimelineSummary,
  };
}

/**
 * The last-known warning: stale, disconnected, or unsupported in-progress readings keep
 * their age visible, while a failed authoritative read warns whenever last-known data exists.
 * The disconnected stream's own reconnect announcement stays with `RealtimeRecoveryNotice`.
 */
function SyncNotice({
  composition,
  hasSyncIssue,
  isRefreshing,
  isRetryScheduled,
  onRetry,
  retryAttempt,
  retryDelayMs,
  syncIssue,
}: {
  composition: WatchComposition;
  hasSyncIssue: boolean;
  isRefreshing: boolean;
  isRetryScheduled: boolean;
  onRetry: () => void;
  retryAttempt: number;
  retryDelayMs: number | null;
  syncIssue: Extract<BackendRead<DashboardProjection>, { status: "unavailable" }> | null;
}) {
  const inProgress =
    composition.phase === "starting" ||
    composition.phase === "active" ||
    composition.phase === "draining";
  const hasLastKnownSyncIssue = hasSyncIssue && composition.panelRecovery.status === "available";
  const freshnessState = composition.freshness.state;
  const freshnessWarning =
    inProgress &&
    (freshnessState === "stale" ||
      freshnessState === "disconnected" ||
      freshnessState === "unsupported");
  if (!freshnessWarning && !hasLastKnownSyncIssue) {
    return null;
  }
  // Same action gate as the technical RecoveryStatusPanel: a server retry-after throttle replaces
  // the manual Refresh action with the scheduled-retry sentence.
  const retryWaitActive = (syncIssue?.retryAfterMs ?? 0) > 0;
  return (
    <div
      aria-live="polite"
      className="col-span-12 grid gap-1 rounded-lg border border-border bg-surface-muted p-3 leading-6 text-muted-strong"
      data-sync-warning=""
      role="status"
    >
      {hasLastKnownSyncIssue ? (
        <>
          <strong>Last-known-good data</strong>
          <p className="m-0 text-sm">
            {isRefreshing
              ? "Refreshing the latest run data now."
              : isRetryScheduled && retryDelayMs !== null
                ? `Retry scheduled in ${formatDurationMs(retryDelayMs) ?? "—"} (attempt ${retryAttempt}).`
                : "The latest authoritative data is unavailable."}
          </p>
          {!retryWaitActive ? (
            <div>
              <button
                className={`${neutralLinkButtonClassName} px-3 py-2`}
                disabled={isRefreshing}
                onClick={onRetry}
                type="button"
              >
                {isRefreshing ? "Refreshing" : "Refresh"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {inProgress ? <FreshnessLine freshness={composition.freshness} /> : null}
    </div>
  );
}

function InvalidAcceptedRunContext() {
  return (
    <section className="col-span-12 rounded-lg border border-warning bg-warning-soft p-4">
      <p className="m-0 text-xs font-bold uppercase text-muted">Saved run report</p>
      <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">
        This Watch link is invalid
      </h2>
      <p className="m-0 mt-2 leading-6 text-muted-strong">
        This link does not identify a saved run. No result has been selected.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <Link className={secondaryActionClassName} href="/run-history">
          Open run history
        </Link>
        <Link className={secondaryActionClassName} href="/demo">
          Choose a simulation
        </Link>
      </div>
    </section>
  );
}

function AcceptedResultNarrative({
  onRetry,
  operatorReset = false,
  result,
  retriesExhausted,
}: {
  operatorReset?: boolean;
  onRetry: () => void;
  result: AcceptedRunResult;
  retriesExhausted: boolean;
}) {
  const reportEvidence = result.status === "available" ? result.reportEvidence : undefined;
  const summary = reportEvidence
    ? derivePublicRunSummary({
        result: reportEvidence.result,
        trafficDeliveryStatus: reportEvidence.trafficDeliveryStatus,
        transportObservation: deriveTransportObservation(
          reportEvidence.transportAttemptCounts,
          reportEvidence.transportFailures,
        ),
      })
    : null;
  const resultIdentity =
    result.status === "available"
      ? `${result.presetName} · ${formatInstantUtc(result.endedAt) ?? result.endedAt}`
      : null;
  return (
    <section
      className="col-span-12 rounded-lg border border-border bg-surface p-4"
      data-accepted-result=""
    >
      <p className="m-0 text-xs font-bold uppercase text-muted">
        {operatorReset ? "Operator-stopped run" : "Your result"}
      </p>
      {summary && resultIdentity ? (
        <>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="m-0 text-xl font-bold leading-tight text-ink">{summary.title}</h2>
            <p className="m-0 text-sm leading-6 text-muted-strong">{summary.sentence}</p>
          </div>
          <p className="m-0 mt-1 text-sm text-muted">{resultIdentity}</p>
          <PublicRunCaveatList caveats={summary.caveats} />
        </>
      ) : (
        <h2 className="m-0 mt-1 text-xl font-bold leading-tight text-ink">
          {result.status === "available" ? "Result available" : "Result being checked"}
        </h2>
      )}
      {result.status === "available" ? (
        <div className="mt-3">
          <Link className={secondaryActionClassName} href={`/run-history/${result.runId}`}>
            View run report
          </Link>
        </div>
      ) : (
        <p className="m-0 mt-2 leading-6 text-muted-strong">
          {result.status === "awaiting"
            ? "The saved result for this run is being checked. Watch will check again for a limited time."
            : retriesExhausted
              ? "The saved result is still unavailable after the automatic checks."
              : "The saved result is temporarily unavailable. Watch will check again for a limited time."}
        </p>
      )}
      {result.status === "unavailable" && retriesExhausted ? (
        <button className={`${secondaryActionClassName} mt-3`} onClick={onRetry} type="button">
          {operatorReset ? "Check stopped result again" : "Check accepted result again"}
        </button>
      ) : null}
    </section>
  );
}

function IdleNarrative() {
  return (
    <section className="col-span-12 rounded-lg border border-border bg-surface p-6">
      <p className="m-0 text-xs font-bold uppercase text-muted">Ready when you are</p>
      <h2 className="m-0 mt-1 text-2xl font-bold leading-tight text-ink">Choose a simulation</h2>
      <p className="m-0 mt-3 max-w-[66ch] leading-6 text-muted">
        Choose a flash-sale scenario, then return here to follow it from setup through the final
        result.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link className={actionClassName} href="/demo">
          Choose a simulation
        </Link>
        <Link className={secondaryActionClassName} href="/run-history">
          See run history
        </Link>
      </div>
    </section>
  );
}

/** Technical sections stay mounted inside one local disclosure across realtime updates. */
function TechnicalGroups({
  acceptedResult,
  composition,
  detailsRef,
  hasSyncIssue,
  isRefreshing,
  onRetry,
  realtimeStatus,
  stoppedRun,
  syncIssue,
}: {
  acceptedResult: AcceptedRunResult | undefined;
  composition: WatchComposition;
  detailsRef: React.RefObject<HTMLDetailsElement | null>;
  hasSyncIssue: boolean;
  isRefreshing: boolean;
  onRetry: () => void;
  realtimeStatus: Parameters<typeof RecoveryStatusPanel>[0]["realtimeStatus"];
  stoppedRun: boolean;
  syncIssue: Extract<BackendRead<DashboardProjection>, { status: "unavailable" }> | null;
}) {
  // A composition carrying a projection is a run phase, so its run-owned evidence exists here.
  const runComposition = "projection" in composition ? composition : null;
  const projection = runComposition?.projection ?? null;
  const run = projection?.currentRun ?? null;
  const outcome = projection?.businessOutcome ?? null;
  const livePhase =
    runComposition !== null &&
    (runComposition.phase === "starting" ||
      runComposition.phase === "active" ||
      runComposition.phase === "draining");
  const acceptedRunIdLine = acceptedResult ? (
    <p className="col-span-12 m-0 break-all text-sm text-muted">
      {stoppedRun ? "Stopped run ID" : "Accepted run ID"}: <code>{acceptedResult.runId}</code>
    </p>
  ) : null;
  const connectionBody = (
    <>
      <RecoveryStatusPanel
        freshness={composition.freshness}
        fullWidth={livePhase || !projection || !run}
        hasSyncIssue={hasSyncIssue}
        isRefreshing={isRefreshing}
        onRefresh={onRetry}
        presentation={composition.presentation}
        realtimeStatus={realtimeStatus}
        recovery={composition.panelRecovery}
        syncIssue={syncIssue}
      />
      {projection && run && !livePhase ? (
        <RequestSurgePanel freshness={composition.freshness} recovery={composition.panelRecovery} />
      ) : null}
      {projection && run ? <SystemStatusPanel recovery={composition.panelRecovery} /> : null}
    </>
  );
  const connectionGroup = (
    <div className="col-span-12" id="watch-advanced-connection" tabIndex={-1}>
      <div className="grid grid-cols-12 gap-4">
        {connectionBody}
        {livePhase ? null : acceptedRunIdLine}
      </div>
    </div>
  );
  const scenarioGroup = run ? (
    <div className="col-span-12" id="watch-advanced-scenario" tabIndex={-1}>
      <div className="grid grid-cols-12 gap-4">
        <ScenarioStrip configSnapshot={run.configSnapshot} />
        <section className="col-span-12 rounded-lg border border-border bg-surface p-4">
          <h2 className="m-0 text-base font-bold leading-tight text-ink">Run identity</h2>
          <dl className="m-0 mt-3 grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
            <div className="min-w-0">
              <dt className="mb-1 text-xs font-bold text-muted">Run UUID</dt>
              <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink">
                <code>{run.runId}</code>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="mb-1 text-xs font-bold text-muted">Started</dt>
              <dd className="m-0 text-sm font-semibold text-ink">
                {formatInstantUtc(run.startedAt) ?? "—"}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="mb-1 text-xs font-bold text-muted">Finalized</dt>
              <dd className="m-0 text-sm font-semibold text-ink">
                {formatInstantUtc(run.finalizedAt) ?? "—"}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  ) : null;
  return (
    <details
      className="col-span-12 rounded-lg border border-border bg-surface"
      open
      ref={detailsRef}
    >
      <summary className="cursor-pointer rounded-lg px-4 py-3 font-bold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        Technical details
      </summary>
      <div className="grid grid-cols-12 gap-4 border-t border-border p-4">
        {runComposition && projection && run ? (
          livePhase ? (
            <>
              <div className="col-span-12" id="watch-advanced-signals" tabIndex={-1}>
                <div className="grid grid-cols-12 gap-4">
                  <LiveTechnicalBoard
                    freshness={composition.freshness}
                    projection={projection}
                    run={run}
                  />
                </div>
              </div>
              <details className="col-span-12 rounded-lg border border-border bg-surface-muted p-4">
                <summary className="cursor-pointer font-semibold text-muted-strong">
                  Run context
                  <span className="ml-2 text-sm font-normal text-muted">
                    {runContextSummary(run)}
                  </span>
                </summary>
                <div className="mt-3 grid grid-cols-12 gap-4">
                  {scenarioGroup}
                  {connectionGroup}
                </div>
              </details>
              <p className="col-span-12 m-0 text-sm leading-6 text-muted">
                Full measurements, charts, and reconciliation proof appear here when the run
                finishes.
              </p>
              {acceptedRunIdLine}
            </>
          ) : (
            <>
              {scenarioGroup}
              <div className="col-span-12" id="watch-advanced-signals" tabIndex={-1}>
                <div className="grid grid-cols-12 gap-4">
                  <GoldSignals {...goldSignalInput(runComposition)} />
                </div>
              </div>
              <div className="col-span-12" id="watch-advanced-processing" tabIndex={-1}>
                <div className="grid grid-cols-12 gap-4">
                  <RunOutcomesPanel
                    freshness={composition.freshness}
                    presentation={deriveOutcomePresentationState(
                      outcome,
                      run,
                      composition.presentation,
                    )}
                    recovery={composition.panelRecovery}
                  />
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
                </div>
              </div>
              <div className="col-span-12" id="watch-advanced-consistency" tabIndex={-1}>
                <div className="grid grid-cols-12 gap-4">
                  <InventoryDrainPanel
                    freshness={composition.freshness}
                    presentation={deriveInventoryOutcomeState(
                      projection.inventory,
                      run,
                      outcome?.reservedUnits ?? null,
                    )}
                    recovery={composition.panelRecovery}
                  />
                  {composition.phase === "completed" || composition.phase === "failed" ? (
                    <div className="col-span-12">
                      <PublicRunConclusionProof result={composition.result} />
                    </div>
                  ) : null}
                </div>
              </div>
              {connectionGroup}
            </>
          )
        ) : (
          connectionGroup
        )}
      </div>
    </details>
  );
}

/** The one-line muted recap inside the live mode's collapsed "Run context" summary. */
function runContextSummary(run: DemoRunSnapshot): string {
  const facts = deriveRunConfigFacts(run.configSnapshot);
  const workers = formatCount(run.configSnapshot.backpressureConfig.orderProcessConcurrency) ?? "—";
  return `${facts.demandValue} attempts · ERP ${facts.erpDelay}, ${facts.erpCapacity} · ${workers} workers · run ${run.runId.slice(0, 8)}…`;
}
