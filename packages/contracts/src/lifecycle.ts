import { z } from "zod";

export const saleOfferPurposeValues = ["catalog", "generated_run"] as const;

export const publicBuyOutcomeValues = [
  "reservation_secured",
  "reservation_pending_persistence",
  "sold_out",
  "run_not_accepting_traffic",
  "inventory_not_initialized",
  "idempotency_conflict",
] as const;

export const reservationDecisionValues = [...publicBuyOutcomeValues, "idempotent_replay"] as const;
export const reservationDecisionSchema = z.enum(reservationDecisionValues);

export const orderStatusValues = ["queued", "processing", "confirmed", "failed"] as const;
export const orderStatusSchema = z.enum(orderStatusValues);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const erpAttemptStatusValues = ["succeeded", "failed", "timed_out"] as const;
export const erpAttemptStatusSchema = z.enum(erpAttemptStatusValues);
export type ErpAttemptStatus = z.infer<typeof erpAttemptStatusSchema>;

/**
 * Operational waiting dimension. A waiting reason is carried by the
 * order's durable control record; the absence of a reason is "not waiting" and
 * is therefore not a vocabulary member.
 */
export const orderWaitingReasonValues = [
  "local_admission",
  "erp_capacity",
  "erp_unavailable",
  "uncertain_result",
] as const;
export const orderWaitingReasonSchema = z.enum(orderWaitingReasonValues);
export type OrderWaitingReason = z.infer<typeof orderWaitingReasonSchema>;

export const technicalOrderFailureCodeValues = [
  "erp_authentication_failed",
  "erp_authorization_failed",
  "erp_response_contract_invalid",
  "erp_idempotency_conflict",
  "erp_attempt_contradiction",
  "erp_lookup_identity_contradiction",
  "accepted_run_snapshot_missing",
  "accepted_run_snapshot_invalid",
  "erp_unrecognized_client_error",
] as const;
export const technicalOrderFailureCodeSchema = z.enum(technicalOrderFailureCodeValues);
export type TechnicalOrderFailureCode = z.infer<typeof technicalOrderFailureCodeSchema>;

export const recoveryJobStatusValues = ["pending", "enqueued", "escalated", "resolved"] as const;

export const orderEventNameValues = [
  "reservation.secured",
  "order.queued",
  "order.processing",
  "order.confirmed",
  "order.failed",
  "notification.recorded",
  "inventory.updated",
  "erp.attempt.failed",
  "erp.attempt.succeeded",
] as const;
export const orderEventNameSchema = z.enum(orderEventNameValues);

export const reservationPendingPersistenceStatusValues = [
  "pending_reconciliation",
  "reconciled",
  "exhausted",
] as const;

export const demoPresetVisibilityValues = ["public", "admin"] as const;
export const demoPresetVisibilitySchema = z.enum(demoPresetVisibilityValues);
export type DemoPresetVisibility = z.infer<typeof demoPresetVisibilitySchema>;

export const operatorModeValues = ["public", "admin"] as const;
export const operatorModeSchema = z.enum(operatorModeValues);
export type OperatorMode = z.infer<typeof operatorModeSchema>;

export const demoRunStatusValues = [
  "starting",
  "active",
  "draining",
  "completed",
  "failed",
] as const;
export const demoRunStatusSchema = z.enum(demoRunStatusValues);
export type DemoRunStatus = z.infer<typeof demoRunStatusSchema>;

export const trafficExecutionStatusValues = [
  "not_started",
  "starting",
  "active",
  "succeeded",
  "failed",
] as const;
export const trafficExecutionStatusSchema = z.enum(trafficExecutionStatusValues);
export type TrafficExecutionStatus = z.infer<typeof trafficExecutionStatusSchema>;

export const trafficCompletionEnrichmentStatusValues = ["pending", "completed"] as const;

export const trafficDeliveryStatusValues = ["complete", "warning", "degraded", "failed"] as const;
export const trafficDeliveryStatusSchema = z.enum(trafficDeliveryStatusValues);
export type TrafficDeliveryStatus = z.infer<typeof trafficDeliveryStatusSchema>;

export const metricNameValues = [
  "traffic.request_arrival_rate",
  "traffic.response_completion_rate",
  "traffic.attempts_dispatched",
  "traffic.latency",
  "traffic.failure_rate",
] as const;
export const metricNameSchema = z.enum(metricNameValues);
