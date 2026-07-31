import type {
  BusinessOutcomeSummary,
  CompletionOutcomeStatus,
  DashboardProjection,
  DemoRunSnapshot,
  ErpResilienceStatus,
  InventoryStatus,
  QueueStatus,
} from "@checkout-surge/contracts";
import type { BackendRead } from "../api";
import type { Freshness } from "./freshness";

export type PresentationTone = "idle" | "progress" | "ok" | "warning" | "danger";

export interface PresentationState {
  state: string;
  tone: PresentationTone;
  label: string;
  description: string;
}

export interface TerminalOutcomeEvidence {
  runStatus: "completed" | "failed";
  oversoldUnits: number;
  failedOrders: number;
  pendingOrders: number;
}

export type TerminalOutcome =
  | "completed-successfully"
  | "completed-with-order-failures"
  | "completed-with-unsettled-orders"
  | "completed-with-oversell"
  | "failed";

/** Temporary A07 integration seam. Replace this implementation with A07's classifier. */
export const classifyTerminalOutcome = (evidence: TerminalOutcomeEvidence): TerminalOutcome => {
  if (evidence.runStatus === "failed") return "failed";
  if (evidence.oversoldUnits > 0) return "completed-with-oversell";
  if (evidence.failedOrders > 0) return "completed-with-order-failures";
  if (evidence.pendingOrders > 0) return "completed-with-unsettled-orders";
  return "completed-successfully";
};

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
    "processing accepted reservations",
    "Accepted reservations are progressing to durable outcomes.",
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
    "The run finalized before every accepted reservation settled.",
  ),
  oversell: state(
    "completed-with-oversell",
    "danger",
    "completed with oversell",
    "Accepted reservations exceeded available stock.",
  ),
  failed: state("failed", "danger", "failed", "The run failed."),
  unavailable: state(
    "updates-disconnected-or-stale",
    "idle",
    "updates unavailable",
    "Current run updates are unavailable.",
  ),
} satisfies Record<string, PresentationState>;

export function deriveRunPresentationState(
  read: BackendRead<DashboardProjection>,
  projection: DashboardProjection | null = read.status === "available" ? read.data : null,
  outcome: TerminalOutcome | null = projection ? terminalOutcome(projection) : null,
): PresentationState {
  if (read.status === "loading") return states.checking;
  if (read.status === "unavailable") return states.unavailable;

  const run = projection?.currentRun ?? null;
  if (!run) return states.ready;
  if (run.status === "starting") return states.starting;
  if (run.status === "active") {
    return run.trafficStatus === "starting" ? states.starting : states.active;
  }
  if (run.status === "draining") return states.draining;

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
    case null:
      return state(
        "terminal-outcome-not-yet-available",
        "idle",
        "outcome not yet available",
        "Terminal outcome evidence is not yet available.",
      );
  }
}

export function terminalOutcome(projection: DashboardProjection): TerminalOutcome | null {
  const run = projection.currentRun;
  if (!run || (run.status !== "completed" && run.status !== "failed")) return null;
  const outcome = projection.businessOutcome;
  const inventory = projection.inventory;
  if (!outcome || !inventory) return run.status === "failed" ? "failed" : null;

  return classifyTerminalOutcome({
    runStatus: run.status,
    // A03 integration: replace this temporary live-input derivation with deriveOversoldUnits.
    oversoldUnits: Math.max(0, outcome.acceptedReservations - inventory.allocatedStock),
    failedOrders: outcome.failedOrders,
    pendingOrders: unsettledOrders(outcome),
  });
}

export function deriveTerminalSummaryPresentation(input: {
  runStatus: DemoRunSnapshot["status"];
  startingStock?: number;
  acceptedReservations: number;
  confirmedOrders: number;
  failedOrders: number;
  pendingPersistenceCount: number;
}): PresentationState {
  if (input.runStatus !== "completed" && input.runStatus !== "failed") {
    return input.runStatus === "draining" ? states.draining : states.starting;
  }
  if (input.startingStock === undefined && input.runStatus === "completed") {
    return state(
      "terminal-outcome-not-yet-available",
      "idle",
      "outcome not yet available",
      "Terminal inventory evidence is not yet available.",
    );
  }

  return presentationForTerminalOutcome(
    classifyTerminalOutcome({
      runStatus: input.runStatus,
      oversoldUnits: Math.max(
        0,
        input.acceptedReservations - (input.startingStock ?? input.acceptedReservations),
      ),
      failedOrders: input.failedOrders,
      pendingOrders:
        Math.max(0, input.acceptedReservations - input.confirmedOrders - input.failedOrders) +
        input.pendingPersistenceCount,
    }),
  );
}

function presentationForTerminalOutcome(outcome: TerminalOutcome): PresentationState {
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
  }
}

export function deriveInventoryOutcomeState(
  inventory: InventoryStatus | null,
  run: DemoRunSnapshot | null,
  acceptedReservations = 0,
): PresentationState {
  if (!inventory)
    return state(
      "inventory-not-yet-available",
      "idle",
      "no data",
      "Inventory evidence is not yet available.",
    );
  const oversoldUnits = Math.max(0, acceptedReservations - inventory.allocatedStock);
  if (oversoldUnits > 0) return states.oversell;
  if (inventory.allocatedStock > 0 && inventory.remainingStock === 0) {
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

export function deriveQueuePresentationState(
  queue: QueueStatus | null,
  run: DemoRunSnapshot | null,
): PresentationState {
  if (!queue)
    return state(
      "queue-not-yet-available",
      "idle",
      "no data",
      "Queue evidence is not yet available.",
    );
  const hasWork = queue.depth > 0 || queue.counts.active > 0;
  if (queue.failedJobs.totalCount > 0) {
    return state("queue-failures", "warning", "failed jobs", "The queue contains failed jobs.");
  }
  if (hasWork && (run?.status === "completed" || run?.status === "failed")) {
    return state(
      "queue-unsettled",
      "warning",
      "backlog remains",
      "Queue work remains after finalization.",
    );
  }
  if (hasWork) return states.draining;
  if (!run) return state("queue-ready", "idle", "ready", "The queue is ready.");
  if (run.status === "completed" || run.status === "failed") {
    return state("queue-drained", "ok", "queue drained", "No queue work remains.");
  }
  return state("queue-no-backlog", "idle", "no backlog", "No queue work is currently waiting.");
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

export function deriveErpPresentationState(erp: ErpResilienceStatus | null): PresentationState {
  if (!erp || erp.recentAttemptCount === 0) {
    return state(
      "erp-not-yet-observed",
      "idle",
      "not yet observed",
      "ERP evidence is not yet available.",
    );
  }
  if (erp.status === "healthy") {
    return state("erp-healthy", "ok", "healthy", "The ERP dependency is healthy.");
  }
  if (erp.status === "degraded") {
    return state("erp-degraded", "warning", "degraded", "The ERP dependency is degraded.");
  }
  return state("erp-unavailable", "danger", "unavailable", "The ERP dependency is unavailable.");
}

export function deriveCompletionOutcomePresentationState(
  status: CompletionOutcomeStatus,
): PresentationState {
  if (status === "confirmed" || status === "notification_recorded") {
    return state(status, "ok", status.replaceAll("_", " "), "Durable workflow step completed.");
  }
  if (status === "failed") {
    return state(status, "warning", "failed", "The order workflow failed.");
  }
  if (status === "delayed" || status === "retrying" || status === "processing") {
    return state(status, "progress", status, "The order workflow is in progress.");
  }
  return state(status, "idle", status, "The order is queued.");
}

function unsettledOrders(outcome: BusinessOutcomeSummary): number {
  return (
    Math.max(0, outcome.acceptedReservations - outcome.confirmedOrders - outcome.failedOrders) +
    outcome.pendingPersistenceCount
  );
}

function hasExpectedWork(outcome: BusinessOutcomeSummary): boolean {
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
