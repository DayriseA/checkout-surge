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
import { getTranslation, type Locale } from "../i18n/translate";
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
    "The load generator is moving to another host (for example, when its host is full), so this start takes a little longer. Please wait.",
  ),
  active: state(
    "accepting-checkout-attempts",
    "progress",
    "accepting checkout attempts",
    "Buyers are arriving.",
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
  locale: Locale = "en",
): PresentationState {
  if (read.status === "loading") return translateState(states.checking, locale);
  if (read.status === "unavailable") return translateState(states.unavailable, locale);

  const run = projection?.currentRun ?? null;
  if (!projection) return translateState(states.ready, locale);
  if (projection.resetRecovery === "incomplete" && !run) {
    return translateState(states.resetRecoveryIncomplete, locale);
  }
  if (!run) return translateState(states.ready, locale);
  if (run.status === "starting")
    return run.runnerRelocating
      ? translateState(states.relocatingRunner, locale)
      : translateState(states.starting, locale);
  if (run.status === "active") {
    return run.trafficStatus === "starting"
      ? translateState(states.starting, locale)
      : translateState(states.active, locale);
  }
  if (run.status === "draining") return translateState(states.draining, locale);

  switch (result?.outcome ?? null) {
    case "completed-successfully":
      return translateState(states.completed, locale);
    case "completed-with-order-failures":
      return translateState(states.orderFailures, locale);
    case "completed-with-unsettled-orders":
      return translateState(states.unsettled, locale);
    case "completed-with-oversell":
      return translateState(states.oversell, locale);
    case "failed":
      return translateState(states.failed, locale);
    case "outcome-indeterminate":
      return result?.maximumClassification === "correctness_failure"
        ? translateState(states.contradictoryOutcome, locale)
        : translateState(states.outcomeIndeterminate, locale);
    case null:
      return translateState(states.outcomeIndeterminate, locale);
  }
}

function terminalResult(projection: DashboardProjection): RunResult | null {
  const run = projection.currentRun;
  if (!run || (run.status !== "completed" && run.status !== "failed")) return null;
  return deriveRunResult(evidenceFromDashboard(projection));
}

export function deriveTerminalSummaryPresentation(
  result: RunResult,
  locale: Locale = "en",
): PresentationState {
  return result.outcome === "outcome-indeterminate" &&
    result.maximumClassification === "correctness_failure"
    ? translateState(states.contradictoryOutcome, locale)
    : presentationForTerminalOutcome(result.outcome, locale);
}

function presentationForTerminalOutcome(
  outcome: RunResult["outcome"],
  locale: Locale = "en",
): PresentationState {
  switch (outcome) {
    case "completed-successfully":
      return translateState(states.completed, locale);
    case "completed-with-order-failures":
      return translateState(states.orderFailures, locale);
    case "completed-with-unsettled-orders":
      return translateState(states.unsettled, locale);
    case "completed-with-oversell":
      return translateState(states.oversell, locale);
    case "failed":
      return translateState(states.failed, locale);
    case "outcome-indeterminate":
      return translateState(states.outcomeIndeterminate, locale);
  }
}

export function deriveInventoryOutcomeState(
  inventory: InventoryStatus | null,
  run: DemoRunSnapshot | null,
  reservedUnits: number | null = null,
  locale: Locale = "en",
): PresentationState {
  const t = getTranslation(locale);
  const terminal = isTerminalRun(run);
  if (!inventory) {
    if (!run) return translateState(states.ready, locale);
    if (terminal) {
      return state(
        "inventory-evidence-unavailable",
        "idle",
        t("inventory evidence unavailable"),
        t("Final inventory evidence was unavailable for this run."),
        locale,
      );
    }
    return state(
      "inventory-not-yet-available",
      "idle",
      t("no data"),
      t("Inventory evidence is not yet available."),
      locale,
    );
  }
  const oversoldUnits =
    reservedUnits === null
      ? null
      : deriveOversoldUnits({ reservedUnits, startingStock: inventory.allocatedStock });
  if (oversoldUnits !== null && oversoldUnits > 0) return translateState(states.oversell, locale);
  if (reservedUnits === null && terminal) {
    return translateState(states.inventoryReservationEvidenceUnavailable, locale);
  }
  if (oversoldUnits === 0 && inventory.allocatedStock > 0 && inventory.remainingStock === 0) {
    return state(
      "exact-sellout",
      "ok",
      t("exact sellout"),
      t("All available stock was reserved without oversell."),
      locale,
    );
  }
  if (run?.status === "completed") {
    return state(
      "completed-with-stock-remaining",
      "idle",
      t("stock remaining"),
      t("The run completed without selling out."),
      locale,
    );
  }
  if (run?.status === "failed") {
    return state(
      "final-inventory-recorded",
      "idle",
      t("final inventory recorded"),
      t("Final inventory evidence was recorded for the failed run."),
      locale,
    );
  }
  if (run) {
    return state(
      "inventory-draining",
      "progress",
      t("inventory draining"),
      t("Stock is being reserved."),
      locale,
    );
  }
  return state("inventory-ready", "idle", t("inventory ready"), t("Inventory is ready."), locale);
}

export function deriveFreshnessPresentationState(
  freshness: Freshness,
  locale: Locale = "en",
): PresentationState {
  const t = getTranslation(locale);
  switch (freshness.state) {
    case "connecting":
      return state(
        "freshness-connecting",
        "idle",
        "connecting",
        t("Connecting to live updates."),
        locale,
      );
    case "live":
      return state(
        "freshness-live",
        "progress",
        t("live updates"),
        t("Live updates are arriving."),
        locale,
      );
    case "retained-fresh":
      return state(
        "freshness-retained",
        "idle",
        "connected",
        t("Connected; no projection update is expected."),
        locale,
      );
    case "stale":
      return state(
        "freshness-stale",
        "idle",
        t("updates stale"),
        t("Projection updates are stale."),
        locale,
      );
    case "disconnected":
      return state(
        "freshness-disconnected",
        "idle",
        t("updates disconnected"),
        t("Live updates are disconnected."),
        locale,
      );
    case "unsupported":
      return state(
        "freshness-unsupported",
        "idle",
        t("live updates unsupported"),
        t("Live updates are unsupported."),
        locale,
      );
    case "not-applicable":
      return state(
        "freshness-not-applicable",
        "idle",
        freshness.final ? "final" : t("no active run"),
        t("Live freshness does not apply."),
        locale,
      );
  }
}

export function deriveLagPresentationState(
  pendingConfirmationCount: number | null,
  confirmedOrderCount: number | null,
  run: DemoRunSnapshot | null,
  locale: Locale = "en",
): PresentationState {
  const t = getTranslation(locale);
  if (pendingConfirmationCount === null || confirmedOrderCount === null) {
    if (!run) return translateState(states.ready, locale);
    if (isTerminalRun(run)) {
      return state(
        "lag-evidence-unavailable",
        "idle",
        t("confirmation evidence unavailable"),
        t("Final confirmation evidence was unavailable for this run."),
        locale,
      );
    }
    return state(
      "lag-not-yet-available",
      "idle",
      t("no data"),
      t("Confirmation evidence is not yet available."),
      locale,
    );
  }
  if (run?.status === "failed") return translateState(states.failed, locale);
  if (pendingConfirmationCount > 0) {
    return run?.status === "completed"
      ? translateState(states.unsettled, locale)
      : translateState(states.draining, locale);
  }
  if (run?.status !== "completed") {
    return state(
      "lag-awaiting-outcomes",
      "idle",
      t("awaiting outcomes"),
      t("No terminal confirmation result exists yet."),
      locale,
    );
  }
  return confirmedOrderCount > 0
    ? translateState(states.completed, locale)
    : state(
        "no-confirmations",
        "idle",
        t("no confirmations"),
        t("No confirmed orders were observed."),
        locale,
      );
}

export function deriveOutcomePresentationState(
  outcome: BusinessOutcomeSummary | null,
  run: DemoRunSnapshot | null,
  runState: PresentationState,
  locale: Locale = "en",
): PresentationState {
  const t = getTranslation(locale);
  if (!outcome) {
    if (!run) return translateState(states.ready, locale);
    if (isTerminalRun(run)) {
      return state(
        "outcome-evidence-unavailable",
        "idle",
        t("checkout evidence unavailable"),
        t("Final checkout outcome evidence was unavailable for this run."),
        locale,
      );
    }
    return state(
      "outcome-not-yet-available",
      "idle",
      t("no data"),
      t("Outcome evidence is not yet available."),
      locale,
    );
  }
  if (run?.status === "completed" || run?.status === "failed") return runState;
  return hasExpectedWork(outcome)
    ? translateState(states.draining, locale)
    : state(
        "outcomes-observed",
        "idle",
        t("outcomes observed"),
        t("Durable outcomes are available."),
        locale,
      );
}

export function deriveRunErpOutcomeState(
  erp: RunErpOutcomeSummary | null,
  run: DemoRunSnapshot | null = null,
  locale: Locale = "en",
): PresentationState {
  const t = getTranslation(locale);
  if (!erp) {
    if (!run) return translateState(states.ready, locale);
    if (isTerminalRun(run)) {
      return state(
        "run-erp-evidence-unavailable",
        "idle",
        t("ERP evidence unavailable"),
        t("Final simulated ERP evidence was unavailable for this run."),
        locale,
      );
    }
    return state(
      "run-erp-not-yet-observed",
      "idle",
      t("not yet observed"),
      t("ERP outcome evidence for this run is not yet available."),
      locale,
    );
  }
  // The recent window is bounded; `latestAttempt` spans retained history, so only its absence
  // proves that no call was recorded.
  if (erp.recentAttemptCount === 0 && erp.latestAttempt === null) {
    if (isTerminalRun(run)) {
      return state(
        "run-erp-not-recorded",
        "idle",
        t("no ERP calls recorded"),
        t("No simulated ERP calls were recorded for this run."),
        locale,
      );
    }
    return state(
      "run-erp-no-calls-yet",
      "idle",
      t("no ERP calls yet"),
      t("No simulated ERP calls have been recorded for this run yet."),
      locale,
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
      t("failures observed"),
      t("This run has recorded ERP failures or timeouts."),
      locale,
    );
  }
  return state(
    "run-erp-outcomes-observed",
    "ok",
    t("outcomes observed"),
    t("ERP attempt outcomes for this run are available."),
    locale,
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
  locale: Locale = "en",
): PresentationState {
  const t = getTranslation(locale);
  return { state: stateName, tone, label: t(label), description: t(description) };
}

function translateState(value: PresentationState, locale: Locale): PresentationState {
  const t = getTranslation(locale);
  return { ...value, label: t(value.label), description: t(value.description) };
}
