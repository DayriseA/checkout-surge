import type {
  BusinessOutcomeSummary,
  DashboardProjection,
  DemoRunSnapshot,
  InventoryStatus,
  RunErpOutcomeSummary,
  RunResult,
} from "@checkout-surge/contracts";
import { deriveOversoldUnits, deriveRunResult } from "@checkout-surge/contracts";
import type { BackendRead } from "../api";
import type { Freshness } from "./freshness";
import { publicVocabulary } from "./public-vocabulary";
import { evidenceFromDashboard } from "./run-result-presentation";

export type PresentationTone = "idle" | "progress" | "ok" | "warning" | "danger";

export interface PresentationState {
  state: string;
  tone: PresentationTone;
  label: string;
  description: string;
}

const states = {
  checking: state(
    "checking-availability",
    "idle",
    "checking availability",
    "Checking availability.",
  ),
  ready: state("ready", "idle", "ready", "Ready to start a run."),
  resetRecoveryIncomplete: state(
    "reset-recovery-incomplete",
    "warning",
    "recovery incomplete",
    "New runs remain unavailable until operator recovery completes.",
  ),
  starting: state("starting", "progress", "starting", "Preparing checkout traffic."),
  relocatingRunner: state(
    "relocating-load-generator",
    "warning",
    "relocating the load generator",
    "Provider capacity issue, relocating the load generator, please wait.",
  ),
  active: state(
    "accepting-checkout-attempts",
    "progress",
    "accepting checkout attempts",
    "Checkout attempts are being accepted.",
  ),
  draining: state(
    "processing-accepted-reservations",
    "progress",
    "processing unique reservations",
    `${publicVocabulary.uniqueReservationsSecured} are waiting to be confirmed or failed.`,
  ),
  completed: state(
    "completed-successfully",
    "ok",
    "completed successfully",
    "The run completed without oversell or unsettled orders.",
  ),
  orderFailures: state(
    "completed-with-order-failures",
    "warning",
    "completed with order failures",
    "The run completed with one or more failed orders.",
  ),
  unsettled: state(
    "completed-with-unsettled-orders",
    "warning",
    "completed with unsettled orders",
    "The run finalized before every unique reservation secured settled.",
  ),
  oversell: state(
    "completed-with-oversell",
    "danger",
    "completed with oversell",
    "Reserved units exceeded available stock.",
  ),
  failed: state("failed", "danger", "failed", "The run failed."),
  unavailable: state(
    "updates-disconnected-or-stale",
    "idle",
    "updates unavailable",
    "Current run updates are unavailable.",
  ),
  outcomeIndeterminate: state(
    "terminal-outcome-unavailable",
    "idle",
    "outcome unavailable",
    "Final outcome evidence was unavailable for this run.",
  ),
  inventoryReservationEvidenceUnavailable: state(
    "inventory-reservation-evidence-unavailable",
    "idle",
    "reservation evidence unavailable",
    "Durable reservation evidence was unavailable for this run.",
  ),
  contradictoryOutcome: state(
    "terminal-outcome-contradictory",
    "danger",
    "contradictory outcome evidence",
    "One or more authoritative final-result checks are broken.",
  ),
} satisfies Record<string, PresentationState>;

export function deriveRunPresentationState(
  read: BackendRead<DashboardProjection>,
  projection: DashboardProjection | null = read.status === "available" ? read.data : null,
  result: RunResult | null = projection ? terminalResult(projection) : null,
): PresentationState {
  if (read.status === "loading") return states.checking;
  if (read.status === "unavailable") return states.unavailable;

  const run = projection?.currentRun ?? null;
  if (!projection) return states.ready;
  if (projection.resetRecovery === "incomplete" && !run) {
    return states.resetRecoveryIncomplete;
  }
  if (!run) return states.ready;
  if (run.status === "starting")
    return run.runnerRelocating ? states.relocatingRunner : states.starting;
  if (run.status === "active") {
    return run.trafficStatus === "starting" ? states.starting : states.active;
  }
  if (run.status === "draining") return states.draining;

  switch (result?.outcome ?? null) {
    case "completed-successfully":
      return states.completed;
    case "completed-with-order-failures":
      return states.orderFailures;
    case "completed-with-unsettled-orders":
      return states.unsettled;
    case "completed-with-oversell":
      return states.oversell;
    case "failed":
      return states.failed;
    case "outcome-indeterminate":
      return result?.maximumClassification === "correctness_failure"
        ? states.contradictoryOutcome
        : states.outcomeIndeterminate;
    case null:
      return states.outcomeIndeterminate;
  }
}

function terminalResult(projection: DashboardProjection): RunResult | null {
  const run = projection.currentRun;
  if (!run || (run.status !== "completed" && run.status !== "failed")) return null;
  return deriveRunResult(evidenceFromDashboard(projection));
}

export function deriveTerminalSummaryPresentation(result: RunResult): PresentationState {
  return result.outcome === "outcome-indeterminate" &&
    result.maximumClassification === "correctness_failure"
    ? states.contradictoryOutcome
    : presentationForTerminalOutcome(result.outcome);
}

function presentationForTerminalOutcome(outcome: RunResult["outcome"]): PresentationState {
  switch (outcome) {
    case "completed-successfully":
      return states.completed;
    case "completed-with-order-failures":
      return states.orderFailures;
    case "completed-with-unsettled-orders":
      return states.unsettled;
    case "completed-with-oversell":
      return states.oversell;
    case "failed":
      return states.failed;
    case "outcome-indeterminate":
      return states.outcomeIndeterminate;
  }
}

export function deriveInventoryOutcomeState(
  inventory: InventoryStatus | null,
  run: DemoRunSnapshot | null,
  reservedUnits: number | null = null,
): PresentationState {
  const terminal = isTerminalRun(run);
  if (!inventory) {
    if (!run) return states.ready;
    if (terminal) {
      return state(
        "inventory-evidence-unavailable",
        "idle",
        "inventory evidence unavailable",
        "Final inventory evidence was unavailable for this run.",
      );
    }
    return state(
      "inventory-not-yet-available",
      "idle",
      "no data",
      "Inventory evidence is not yet available.",
    );
  }
  const oversoldUnits =
    reservedUnits === null
      ? null
      : deriveOversoldUnits({ reservedUnits, startingStock: inventory.allocatedStock });
  if (oversoldUnits !== null && oversoldUnits > 0) return states.oversell;
  if (reservedUnits === null && terminal) {
    return states.inventoryReservationEvidenceUnavailable;
  }
  if (oversoldUnits === 0 && inventory.allocatedStock > 0 && inventory.remainingStock === 0) {
    return state(
      "exact-sellout",
      "ok",
      "exact sellout",
      "All available stock was reserved without oversell.",
    );
  }
  if (run?.status === "completed") {
    return state(
      "completed-with-stock-remaining",
      "idle",
      "stock remaining",
      "The run completed without selling out.",
    );
  }
  if (run?.status === "failed") {
    return state(
      "final-inventory-recorded",
      "idle",
      "final inventory recorded",
      "Final inventory evidence was recorded for the failed run.",
    );
  }
  if (run) {
    return state(
      "inventory-draining",
      "progress",
      "inventory draining",
      "Stock is being reserved.",
    );
  }
  return state("inventory-ready", "idle", "inventory ready", "Inventory is ready.");
}

export function deriveFreshnessPresentationState(freshness: Freshness): PresentationState {
  switch (freshness.state) {
    case "connecting":
      return state("freshness-connecting", "idle", "connecting", "Connecting to live updates.");
    case "live":
      return state("freshness-live", "progress", "live updates", "Live updates are arriving.");
    case "retained-fresh":
      return state(
        "freshness-retained",
        "idle",
        "connected",
        "Connected; no projection update is expected.",
      );
    case "stale":
      return state("freshness-stale", "idle", "updates stale", "Projection updates are stale.");
    case "disconnected":
      return state(
        "freshness-disconnected",
        "idle",
        "updates disconnected",
        "Live updates are disconnected.",
      );
    case "unsupported":
      return state(
        "freshness-unsupported",
        "idle",
        "live updates unsupported",
        "Live updates are unsupported.",
      );
    case "not-applicable":
      return state(
        "freshness-not-applicable",
        "idle",
        freshness.final ? "final" : "no active run",
        "Live freshness does not apply.",
      );
  }
}

export function deriveLagPresentationState(
  pendingConfirmationCount: number | null,
  confirmedOrderCount: number | null,
  run: DemoRunSnapshot | null,
): PresentationState {
  if (pendingConfirmationCount === null || confirmedOrderCount === null) {
    if (!run) return states.ready;
    if (isTerminalRun(run)) {
      return state(
        "lag-evidence-unavailable",
        "idle",
        "confirmation evidence unavailable",
        "Final confirmation evidence was unavailable for this run.",
      );
    }
    return state(
      "lag-not-yet-available",
      "idle",
      "no data",
      "Confirmation evidence is not yet available.",
    );
  }
  if (run?.status === "failed") return states.failed;
  if (pendingConfirmationCount > 0) {
    return run?.status === "completed" ? states.unsettled : states.draining;
  }
  if (run?.status !== "completed") {
    return state(
      "lag-awaiting-outcomes",
      "idle",
      "awaiting outcomes",
      "No terminal confirmation result exists yet.",
    );
  }
  return confirmedOrderCount > 0
    ? states.completed
    : state("no-confirmations", "idle", "no confirmations", "No confirmed orders were observed.");
}

export function deriveOutcomePresentationState(
  outcome: BusinessOutcomeSummary | null,
  run: DemoRunSnapshot | null,
  runState: PresentationState,
): PresentationState {
  if (!outcome) {
    if (!run) return states.ready;
    if (isTerminalRun(run)) {
      return state(
        "outcome-evidence-unavailable",
        "idle",
        "checkout evidence unavailable",
        "Final checkout outcome evidence was unavailable for this run.",
      );
    }
    return state(
      "outcome-not-yet-available",
      "idle",
      "no data",
      "Outcome evidence is not yet available.",
    );
  }
  if (run?.status === "completed" || run?.status === "failed") return runState;
  return hasExpectedWork(outcome)
    ? states.draining
    : state("outcomes-observed", "idle", "outcomes observed", "Durable outcomes are available.");
}

export function deriveRunErpOutcomeState(
  erp: RunErpOutcomeSummary | null,
  run: DemoRunSnapshot | null = null,
): PresentationState {
  if (!erp) {
    if (!run) return states.ready;
    if (isTerminalRun(run)) {
      return state(
        "run-erp-evidence-unavailable",
        "idle",
        "ERP evidence unavailable",
        "Final simulated ERP evidence was unavailable for this run.",
      );
    }
    return state(
      "run-erp-not-yet-observed",
      "idle",
      "not yet observed",
      "ERP outcome evidence for this run is not yet available.",
    );
  }
  // The recent window is bounded; `latestAttempt` spans retained history, so only its absence
  // proves that no call was recorded.
  if (erp.recentAttemptCount === 0 && erp.latestAttempt === null) {
    if (isTerminalRun(run)) {
      return state(
        "run-erp-not-recorded",
        "idle",
        "no ERP calls recorded",
        "No simulated ERP calls were recorded for this run.",
      );
    }
    return state(
      "run-erp-no-calls-yet",
      "idle",
      "no ERP calls yet",
      "No simulated ERP calls have been recorded for this run yet.",
    );
  }
  if (
    erp.recentFailureCount > 0 ||
    erp.recentTimeoutCount > 0 ||
    erp.latestAttempt?.status === "failed" ||
    erp.latestAttempt?.status === "timed_out"
  ) {
    return state(
      "run-erp-failures-observed",
      "warning",
      "failures observed",
      "This run has recorded ERP failures or timeouts.",
    );
  }
  return state(
    "run-erp-outcomes-observed",
    "ok",
    "outcomes observed",
    "ERP attempt outcomes for this run are available.",
  );
}

export function hasExpectedWork(outcome: BusinessOutcomeSummary): boolean {
  return (
    outcome.pendingPersistenceCount +
      outcome.queuedOrders +
      outcome.processingOrders +
      outcome.retryingOrders >
    0
  );
}

function isTerminalRun(run: DemoRunSnapshot | null): boolean {
  return run?.status === "completed" || run?.status === "failed";
}

function state(
  stateName: string,
  tone: PresentationTone,
  label: string,
  description: string,
): PresentationState {
  return { state: stateName, tone, label, description };
}
