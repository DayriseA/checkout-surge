import type {
  DemoRunStatus,
  DownstreamErpStatus,
  ErpAttemptStatus,
  PublicRunFailureCategory,
  RunResultOutcome,
  TrafficDeliveryStatus,
  TrafficExecutionStatus,
} from "@checkout-surge/contracts";
import { liveTrafficMetricWindowSeconds } from "@checkout-surge/contracts";
import { getTranslation, type Locale } from "../i18n/translate";

/**
 * Public copy is intentionally a presentation boundary. Contracts keep the canonical enum and
 * population names; this module gives visitors one human term for each concept without changing
 * the underlying meaning. In particular, warning and degraded traffic delivery are both partial
 * delivery in the public hierarchy because they do not require different visitor action.
 */

export const publicVocabulary = {
  acceptedResponses: "accepted responses",
  uniqueReservationsSecured: "Unique reservations secured",
  soldOutRejectionsRecorded: "sold-out rejections recorded by Checkout-Surge",
  soldOutRejectionsSeen: "sold-out rejections seen by the load generator",
  httpFailurePopulation: "load-generator attempts; connection failures may have no response",
  startingStock: "starting stock",
  pendingReservations: "reservations awaiting durable storage",
  expiredReservations: "reservations past their deadline, still reserved",
  consistencyLag: "reservation-to-confirmation time",
  notifications: "simulated emails recorded",
  durableCheckoutRecords: "Durable checkout records",
  loadGenerator: "Load generator",
  trafficDelivery: "Traffic delivery",
  runLifecycle: "Run",
} as const;

export const publicNarrative = {
  repositoryUrl: "https://github.com/DayriseA/checkout-surge",
} as const;

export { liveTrafficMetricWindowSeconds };

export type PublicStatus =
  | { family: "load-generator"; status: TrafficExecutionStatus }
  | { family: "traffic-delivery"; status: TrafficDeliveryStatus }
  | { family: "run"; status: DemoRunStatus; displayLabel?: string };

export function trafficModeLabel(
  mode: "buyer-spike" | "constant-arrival-rate",
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  return mode === "buyer-spike" ? t("Everyone at once") : t("Steady stream");
}

export function outcomeFocusLabel(focus: string, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  switch (focus) {
    case "happy_path":
      return t("Reservations confirm cleanly");
    case "sold_out":
      return t("Stock depletes without overselling");
    case "queue_pressure":
      return t("The order backlog grows, then drains");
    case "run_history":
      return t("The final evidence remains available");
    case "idempotency":
      return t("Duplicate clicks replay one reservation");
    case "downstream_capacity":
      return t("A slow ERP sets the pace; orders wait in the queue");
    case "downstream_latency":
      return t("Slow ERP responses limit orders in flight");
    case "confirmation_wait":
      return t("Without the queue, each winner waits for the ERP to confirm");
    case "failure_path":
      return t("Failed orders and retries");
    default:
      return focus.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
  }
}

export function erpAttemptStatusLabel(status: ErpAttemptStatus, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  switch (status) {
    case "succeeded":
      return t("Succeeded");
    case "failed":
      return t("Failed");
    case "timed_out":
      return t("Timed out");
    default:
      return t("Status unavailable");
  }
}

export function trafficExecutionStatusLabel(
  status: TrafficExecutionStatus,
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  switch (status) {
    case "not_started":
      return t("Not started");
    case "starting":
      return t("Starting");
    case "active":
      return t("Running");
    case "succeeded":
      return t("Finished");
    case "failed":
      return t("Failed");
  }
}

export function trafficDeliveryStatusLabel(
  status: TrafficDeliveryStatus,
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  switch (status) {
    case "complete":
      return t("All planned attempts completed");
    case "warning":
    case "degraded":
      return t("Partial delivery");
    case "failed":
      return t("Delivery failed");
    default:
      return t("Delivery status unavailable");
  }
}

export function trafficDeliveryStatusTone(
  status: TrafficDeliveryStatus,
): "ok" | "warning" | "danger" {
  return status === "complete" ? "ok" : status === "failed" ? "danger" : "warning";
}

export function runLifecycleStatusLabel(status: DemoRunStatus, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  switch (status) {
    case "starting":
      return t("Starting");
    case "active":
      return t("Active");
    case "draining":
      return t("Finishing");
    case "completed":
      return t("Completed");
    case "failed":
      return t("Failed");
  }
}

export function runResultOutcomeLabel(outcome: RunResultOutcome, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  switch (outcome) {
    case "completed-successfully":
      return t("Completed");
    case "completed-with-order-failures":
      return t("Completed with order failures");
    case "completed-with-unsettled-orders":
      return t("Completed with unsettled orders");
    case "completed-with-oversell":
      return t("Oversell detected");
    case "failed":
      return t("Failed");
    case "outcome-indeterminate":
      return t("Result not fully verified");
  }
}

export function runResultOutcomeTone(
  outcome: RunResultOutcome,
): "ok" | "warning" | "danger" | "idle" {
  switch (outcome) {
    case "completed-successfully":
      return "ok";
    case "completed-with-order-failures":
    case "completed-with-unsettled-orders":
      return "warning";
    case "completed-with-oversell":
    case "failed":
      return "danger";
    case "outcome-indeterminate":
      return "idle";
  }
}

/**
 * The one explanation of a failed run, shared by the run's verdict on every surface and by the
 * answer to a start that failed, so a visitor reads the same words at start time and later.
 */
export function publicFailureExplanation(
  category: PublicRunFailureCategory,
  locale: Locale = "en",
): {
  explanation: string;
  action: string;
} {
  const t = getTranslation(locale);
  switch (category) {
    case "traffic":
      return {
        explanation: t(
          "The load generator could not deliver the planned traffic, so this run's evidence is incomplete.",
        ),
        action: t("Start a new run to try again."),
      };
    case "not_started":
      // A run refused while the demo is updated is stored with this category too: the stored
      // run cannot tell the two apart, so the text stays true for both.
      return {
        explanation: t("The load generator could not be started, so no traffic was sent."),
        action: t("Start a new run to try again."),
      };
    case "provider_capacity":
      return {
        explanation: t(
          "The hosting provider (Fly.io) had no room for the load generator, so no traffic was sent.",
        ),
        action: t("Try again later."),
      };
    case "inventory":
      return {
        explanation: t("The run could not prepare its stock, so no traffic was sent."),
        action: t("Start a new run to try again."),
      };
    case "automatic_reset":
      return {
        explanation: t(
          "The run was cancelled by an automatic reset. Its experiment data was discarded.",
        ),
        action: t("Start a new run when the demo is ready."),
      };
    case "operator":
      return {
        explanation: t("The run was stopped by an operator before a complete result was recorded."),
        action: t("Start a new run when the demo is ready."),
      };
  }
}

/**
 * Which producer owns a missing value decides when its absence stops being provisional. The load
 * generator stops producing when traffic ends, which the lifecycle records as `draining`, so
 * traffic evidence is already final while the run keeps processing reservations. Durable
 * processing evidence keeps arriving until the run reaches a terminal status.
 */
export type RunEvidenceSource = "load-generator" | "durable-processing";

export function isRunEvidenceSettled(status: DemoRunStatus, source: RunEvidenceSource): boolean {
  if (status === "completed" || status === "failed") return true;
  return source === "load-generator" && status === "draining";
}

/**
 * Absence copy for one fact. `pending` may promise later evidence; `settled` must not, because no
 * further evidence can arrive for that source.
 */
export function runEvidenceAbsence(
  status: DemoRunStatus | null,
  evidence: { source: RunEvidenceSource; pending: string; settled: string },
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  if (status === null) return t("No run has started");
  return t(isRunEvidenceSettled(status, evidence.source) ? evidence.settled : evidence.pending);
}

export function publicStatusLabel(input: PublicStatus, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  switch (input.family) {
    case "load-generator":
      return `${t(publicVocabulary.loadGenerator)}: ${trafficExecutionStatusLabel(input.status, locale)}`;
    case "traffic-delivery":
      return `${t(publicVocabulary.trafficDelivery)}: ${trafficDeliveryStatusLabel(input.status, locale)}`;
    case "run":
      return `${t(publicVocabulary.runLifecycle)}: ${input.displayLabel ?? runLifecycleStatusLabel(input.status, locale)}`;
  }
}

/**
 * The one public label for the projected downstream status. The status is the only fact the
 * server exposes — never cooldown times or protection internals — so the label carries the whole
 * explanation: a limited or unavailable downstream keeps processing and recovers on its own.
 */
export function downstreamErpStatusLabel(
  status: DownstreamErpStatus,
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  switch (status) {
    case "nominal":
      return t("Processing normally");
    case "erp_limiting":
      return t("Still processing — the ERP is limiting the rate");
    case "erp_unavailable":
      return t("ERP unavailable — processing resumes automatically");
  }
}

export function queueConnectivityLabel(connectivity: string, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  return connectivity === "reachable" ? t("Available") : t("Needs attention");
}

export function rateWindowLabel(windowSeconds: number, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  const seconds = new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: 2,
  }).format(windowSeconds);
  return t("{v0}-second window", { v0: String(seconds) });
}

export function trailingRateWindowLabel(windowSeconds: number, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  const seconds = new Intl.NumberFormat(locale === "fr" ? "fr-FR" : "en-US", {
    maximumFractionDigits: 2,
  }).format(windowSeconds);
  return t("trailing {v0}-second measurement window", { v0: String(seconds) });
}

export const liveTrafficWindowLabel = rateWindowLabel(liveTrafficMetricWindowSeconds);

export const loadGeneratorLens = {
  title: publicVocabulary.loadGenerator,
  caption: "what the load generator observed",
} as const;

export const durableCheckoutLens = {
  title: publicVocabulary.durableCheckoutRecords,
  caption: "Reservation and order outcomes recorded by Checkout-Surge",
} as const;

export const simulatedErpLens = {
  title: "Simulated ERP calls",
  caption: "Calls to the simulated ERP recorded by Checkout-Surge",
} as const;
