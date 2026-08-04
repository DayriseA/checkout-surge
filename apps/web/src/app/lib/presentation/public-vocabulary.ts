import type {
  DemoRunStatus,
  ErpAttemptStatus,
  ErpCircuitState,
  TrafficDeliveryStatus,
  TrafficExecutionStatus,
} from "@checkout-surge/contracts";
import { liveTrafficMetricWindowSeconds } from "@checkout-surge/contracts";

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
  expiredReservations: "holds past deadline, still reserved",
  consistencyLag: "reservation-to-confirmation time",
  notifications: "simulated emails recorded",
  durableCheckoutRecords: "Durable checkout records",
  loadGenerator: "Load generator",
  trafficDelivery: "Traffic delivery",
  runLifecycle: "Run",
} as const;

export { liveTrafficMetricWindowSeconds };

export type PublicStatus =
  | { family: "load-generator"; status: TrafficExecutionStatus }
  | { family: "traffic-delivery"; status: TrafficDeliveryStatus }
  | { family: "run"; status: DemoRunStatus; displayLabel?: string };

export function trafficModeLabel(mode: "buyer-spike" | "constant-arrival-rate"): string {
  return mode === "buyer-spike" ? "Everyone at once" : "Steady stream";
}

export function erpAttemptStatusLabel(status: ErpAttemptStatus): string {
  switch (status) {
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "timed_out":
      return "Timed out";
    default:
      return "Status unavailable";
  }
}

export function publicLimitsLabel(enforced: boolean | undefined): string {
  if (enforced === true) return "Public limits apply";
  if (enforced === false) return "Public limits not applied";
  return "Public limits unavailable";
}

export function trafficExecutionStatusLabel(status: TrafficExecutionStatus): string {
  switch (status) {
    case "not_started":
      return "Not started";
    case "starting":
      return "Starting";
    case "active":
      return "Running";
    case "succeeded":
      return "Finished";
    case "failed":
      return "Failed";
  }
}

export function trafficDeliveryStatusLabel(status: TrafficDeliveryStatus): string {
  switch (status) {
    case "complete":
      return "All planned attempts dispatched";
    case "warning":
    case "degraded":
      return "Partial delivery";
    case "failed":
      return "Delivery failed";
    default:
      return "Delivery status unavailable";
  }
}

export function trafficDeliveryStatusTone(
  status: TrafficDeliveryStatus,
): "ok" | "warning" | "danger" {
  return status === "complete" ? "ok" : status === "failed" ? "danger" : "warning";
}

export function runLifecycleStatusLabel(status: DemoRunStatus): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "active":
      return "Active";
    case "draining":
      return "Finishing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
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
): string {
  if (status === null) return "No run has started";
  return isRunEvidenceSettled(status, evidence.source) ? evidence.settled : evidence.pending;
}

export function publicStatusLabel(input: PublicStatus): string {
  switch (input.family) {
    case "load-generator":
      return `${publicVocabulary.loadGenerator}: ${trafficExecutionStatusLabel(input.status)}`;
    case "traffic-delivery":
      return `${publicVocabulary.trafficDelivery}: ${trafficDeliveryStatusLabel(input.status)}`;
    case "run":
      return `${publicVocabulary.runLifecycle}: ${input.displayLabel ?? runLifecycleStatusLabel(input.status)}`;
  }
}

export function circuitStateLabel(state: ErpCircuitState): string {
  switch (state) {
    case "closed":
      return "Protection normal";
    case "open":
      return "Calls paused to protect the ERP";
    case "half_open":
      return "Testing recovery";
  }
}

export function protectionReasonLabel(reason: string | null): string {
  switch (reason) {
    case null:
      return "normal";
    case "circuit_open":
      return "Calls paused to protect the ERP";
    case "circuit_state_unavailable":
      return "Protection status unavailable";
    case "circuit_state_missing":
      return "Protection not yet exercised";
    case "circuit_half_open":
      return "Testing recovery";
    case "retry_pressure_unavailable":
      return "Retry status unavailable";
    case "erp_retries_pending":
      return "ERP retries are pending";
    default:
      return "Protection needs attention";
  }
}

export function readinessCheckLabel(name: string): string {
  switch (name) {
    case "database_reachable":
      return "Database";
    case "redis_reachable":
      return "Inventory reservation";
    case "order_process_queue_reachable":
      return "Order processing";
    case "mock_erp_reachable":
      return "Simulated ERP";
    case "load_orchestrator_reachable":
      return "Load generator";
    default:
      return "Service readiness";
  }
}

export function readinessCheckStatusLabel(status: "ok" | "degraded" | "unavailable"): string {
  switch (status) {
    case "ok":
      return "Ready";
    case "degraded":
      return "Needs attention";
    case "unavailable":
      return "Unavailable";
  }
}

export function queueConnectivityLabel(connectivity: string): string {
  return connectivity === "reachable" ? "Available" : "Needs attention";
}

export function rateWindowLabel(windowSeconds: number): string {
  const seconds = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    windowSeconds,
  );
  return `${seconds}-second window`;
}

export function trailingRateWindowLabel(windowSeconds: number): string {
  const seconds = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    windowSeconds,
  );
  return `trailing ${seconds}-second measurement window`;
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
