import {
  type DashboardProjection,
  type DemoRunSnapshot,
  deriveRunResult,
  type RunHistoryListItem,
  type RunResult,
} from "@checkout-surge/contracts";
import type { BackendRead } from "../api";
import type { RetainedTerminalRun, RunSignalLiveSample } from "../dashboard-projection-state";
import type { AcceptedRunResult } from "./accepted-run-result";
import {
  dashboardUpdateExpected,
  deriveFreshness,
  type Freshness,
  type RealtimeConnectionStatus,
} from "./freshness";
import { deriveRunPresentationState, type PresentationState } from "./run-presentation-state";
import { evidenceFromDashboard } from "./run-result-presentation";

interface WatchCompositionBase {
  freshness: Freshness;
  panelRecovery: BackendRead<DashboardProjection>;
  presentation: PresentationState;
}

type InProgressWatchComposition<Phase extends "starting" | "active" | "draining"> =
  WatchCompositionBase & {
    phase: Phase;
    projection: DashboardProjection;
    run: DemoRunSnapshot;
    signalSamples: RunSignalLiveSample[];
  };

type TerminalWatchComposition<Phase extends "completed" | "failed"> = WatchCompositionBase & {
  phase: Phase;
  projection: DashboardProjection;
  result: RunResult;
  run: DemoRunSnapshot;
};

export type WatchComposition =
  | (WatchCompositionBase & {
      phase: "checking" | "unavailable" | "reset-recovery";
    })
  | (WatchCompositionBase & {
      phase: "idle";
      latestCompletedRun: BackendRead<RunHistoryListItem | null>;
    })
  | (WatchCompositionBase & { phase: "cancelled"; run: DemoRunSnapshot; automatic: boolean })
  | InProgressWatchComposition<"starting">
  | InProgressWatchComposition<"active">
  | InProgressWatchComposition<"draining">
  | TerminalWatchComposition<"completed">
  | TerminalWatchComposition<"failed">;

export function deriveWatchComposition(input: {
  acceptedResult?: AcceptedRunResult | undefined;
  recovery: BackendRead<DashboardProjection>;
  retainedTerminalRun: RetainedTerminalRun | null;
  latestCompletedRun: BackendRead<RunHistoryListItem | null>;
  signalSamples: RunSignalLiveSample[];
  transportStatus: RealtimeConnectionStatus;
  now: Date;
}): WatchComposition {
  const recoveredProjection = input.recovery.status === "available" ? input.recovery.data : null;
  const incompleteReset = recoveredProjection?.resetRecovery === "incomplete";
  const retainedProjection = input.retainedTerminalRun?.terminalRecap ?? null;
  const projection = incompleteReset
    ? recoveredProjection
    : recoveredProjection?.currentRun === null
      ? retainedProjection
        ? { ...retainedProjection, systemStatus: recoveredProjection.systemStatus }
        : recoveredProjection
      : (recoveredProjection ?? retainedProjection);
  const panelRecovery: BackendRead<DashboardProjection> = projection
    ? { status: "available", data: projection, httpStatus: 200 }
    : input.recovery;
  const savedCancellation =
    input.acceptedResult?.status === "available" &&
    input.acceptedResult.runId === projection?.currentRun?.runId
      ? input.acceptedResult.cancellation
      : undefined;
  const discarded =
    projection?.currentRun?.dataDiscarded === true || savedCancellation !== undefined;
  const presentation: PresentationState = discarded
    ? {
        state: "cancelled",
        label: "Cancelled",
        tone: "idle",
        description: "Its experiment data was discarded.",
      }
    : deriveRunPresentationState(panelRecovery, projection);
  const freshness = deriveFreshness({
    transportStatus: input.transportStatus,
    recoveredAt: projection?.recoveredAt ?? input.now.toISOString(),
    now: input.now,
    lifecycle: projection?.currentRun?.status ?? null,
    updateExpected: projection ? dashboardUpdateExpected(projection) : false,
  });
  if (projection === null) {
    return {
      phase: input.recovery.status === "loading" ? "checking" : "unavailable",
      freshness,
      panelRecovery,
      presentation,
    };
  }

  if (incompleteReset) return { phase: "reset-recovery", freshness, panelRecovery, presentation };

  const run = projection.currentRun;
  if (run === null) {
    return {
      phase: "idle",
      freshness,
      latestCompletedRun: input.latestCompletedRun,
      panelRecovery,
      presentation,
    };
  }

  if (discarded)
    return {
      phase: "cancelled",
      freshness,
      panelRecovery,
      presentation,
      run,
      automatic: savedCancellation?.automatic ?? run.failureCategory === "automatic_reset",
    };

  const phase = phaseFromPresentation(presentation);
  if (phase === "completed" || phase === "failed") {
    return {
      phase,
      freshness,
      panelRecovery,
      presentation,
      projection,
      result: deriveRunResult(evidenceFromDashboard(projection)),
      run,
    };
  }

  return {
    phase,
    freshness,
    panelRecovery,
    presentation,
    projection,
    run,
    signalSamples: input.signalSamples,
  };
}

function phaseFromPresentation(
  presentation: PresentationState,
): Exclude<
  WatchComposition["phase"],
  "checking" | "unavailable" | "idle" | "reset-recovery" | "cancelled"
> {
  switch (presentation.state) {
    case "starting":
      return "starting";
    case "accepting-checkout-attempts":
      return "active";
    case "processing-accepted-reservations":
      return "draining";
    case "failed":
      return "failed";
    case "completed-successfully":
    case "completed-with-order-failures":
    case "completed-with-unsettled-orders":
    case "completed-with-oversell":
    case "terminal-outcome-unavailable":
    case "terminal-outcome-contradictory":
      return "completed";
    default:
      throw new Error(`Run presentation ${presentation.state} has no watch composition.`);
  }
}
