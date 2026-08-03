import type {
  BusinessOutcomeSummary,
  DashboardProjection,
  DemoRunSnapshot,
  InventoryStatus,
  RunErpOutcomeSummary,
  RunResult,
  SharedErpProtectionStatus,
  SharedRuntimeStatus,
} from "@checkout-surge/contracts";
import { deriveOversoldUnits, deriveRunResult } from "@checkout-surge/contracts";
import type { BackendRead } from "../api";
import type { Freshness } from "./freshness";
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
  starting: state("starting", "progress", "starting", "Preparing checkout traffic."),
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
    "Unique reservations secured are progressing to durable outcomes.",
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
    "terminal-outcome-not-yet-available",
    "idle",
    "outcome not yet available",
    "Terminal outcome evidence is not yet available.",
  ),
  inventoryReservationEvidenceUnavailable: state(
    "inventory-reservation-evidence-not-yet-available",
    "idle",
    "reservation evidence not yet available",
    "Durable reservation evidence is not yet available.",
  ),
  contradictoryOutcome: state(
    "terminal-outcome-contradictory",
    "danger",
    "contradictory outcome evidence",
    "One or more authoritative terminal invariants are broken.",
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
  if (!projection || !run) return states.ready;
  if (run.status === "starting") return states.starting;
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
      return state(
        "terminal-outcome-not-yet-available",
        "idle",
        "outcome not yet available",
        "Terminal outcome evidence is not yet available.",
      );
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
  if (!inventory)
    return state(
      "inventory-not-yet-available",
      "idle",
      "no data",
      "Inventory evidence is not yet available.",
    );
  const oversoldUnits =
    reservedUnits === null
      ? null
      : deriveOversoldUnits({ reservedUnits, startingStock: inventory.allocatedStock });
  if (oversoldUnits !== null && oversoldUnits > 0) return states.oversell;
  if (reservedUnits === null && run?.status === "completed") {
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
  if (run && run.status !== "failed") {
    return state(
      "inventory-draining",
      "progress",
      "inventory draining",
      "Stock is being reserved.",
    );
  }
  return state("inventory-ready", "idle", "inventory ready", "Inventory is ready.");
}

export function deriveSharedRuntimeState(
  systemStatus: SharedRuntimeStatus | null,
): PresentationState {
  if (!systemStatus)
    return state(
      "shared-runtime-not-yet-available",
      "idle",
      "no data",
      "Shared demo-runtime state is not yet available.",
    );
  if (systemStatus.erpProtection.status === "unavailable") {
    return state(
      "shared-runtime-unavailable",
      "danger",
      "protection unavailable",
      "Shared ERP protection is unavailable.",
    );
  }
  if (
    systemStatus.erpProtection.status === "degraded" ||
    systemStatus.queue.failedJobs.totalCount > 0
  ) {
    return state(
      "shared-runtime-degraded",
      "warning",
      "attention needed",
      "Shared demo-runtime protection or queue state needs attention.",
    );
  }
  if (systemStatus.queue.depth > 0 || systemStatus.queue.counts.active > 0) {
    return state(
      "shared-runtime-busy",
      "progress",
      "runtime busy",
      "The shared physical queue is processing work.",
    );
  }
  return state(
    "shared-runtime-ready",
    "ok",
    "runtime ready",
    "The shared physical queue and ERP protection are ready.",
  );
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
    return state(
      "lag-not-yet-available",
      "idle",
      "no data",
      "Confirmation evidence is not yet available.",
    );
  }
  if (pendingConfirmationCount > 0) {
    return run?.status === "completed" || run?.status === "failed"
      ? states.unsettled
      : states.draining;
  }
  if (!run || (run.status !== "completed" && run.status !== "failed")) {
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
  if (!outcome)
    return state(
      "outcome-not-yet-available",
      "idle",
      "no data",
      "Outcome evidence is not yet available.",
    );
  if (run?.status === "completed" || run?.status === "failed") return runState;
  return hasExpectedWork(outcome)
    ? states.draining
    : state("outcomes-observed", "idle", "outcomes observed", "Durable outcomes are available.");
}

export function deriveRunErpOutcomeState(erp: RunErpOutcomeSummary | null): PresentationState {
  if (!erp) {
    return state(
      "run-erp-not-yet-observed",
      "idle",
      "not yet observed",
      "ERP outcome evidence for this run is not yet available.",
    );
  }
  if (erp.circuitReadStatus === "unavailable") {
    return state(
      "run-erp-protection-unavailable",
      "warning",
      "protection unavailable",
      "ERP attempt outcomes are available, but this run's protection state could not be read.",
    );
  }
  if (!erp.circuit && erp.recentAttemptCount === 0) {
    return state(
      "run-erp-protection-not-exercised",
      "idle",
      "not yet exercised",
      "This run has not exercised ERP protection.",
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
      "This run has ERP failures or timeouts in the recent attempt window.",
    );
  }
  return state(
    "run-erp-outcomes-observed",
    "ok",
    "outcomes observed",
    "ERP attempt outcomes for this run are available.",
  );
}

export function deriveSharedErpProtectionState(
  protection: SharedErpProtectionStatus | null,
): PresentationState {
  if (!protection) {
    return state(
      "shared-erp-protection-not-yet-available",
      "idle",
      "no data",
      "Shared ERP protection state is not yet available.",
    );
  }
  if (protection.status === "healthy") {
    return state(
      "shared-erp-protection-healthy",
      "ok",
      "healthy",
      "Shared ERP protection is healthy.",
    );
  }
  if (protection.status === "degraded") {
    return state(
      "shared-erp-protection-degraded",
      "warning",
      "degraded",
      "Shared ERP protection is degraded.",
    );
  }
  return state(
    "shared-erp-protection-unavailable",
    "danger",
    "unavailable",
    "Shared ERP protection is unavailable.",
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

function state(
  stateName: string,
  tone: PresentationTone,
  label: string,
  description: string,
): PresentationState {
  return { state: stateName, tone, label, description };
}
