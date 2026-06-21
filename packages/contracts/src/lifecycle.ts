import { z } from "zod";
import { orderProcessQueueName } from "./queue.js";

export const saleOfferPurposeValues = ["catalog", "generated_run"] as const;
export const saleOfferPurposeSchema = z.enum(saleOfferPurposeValues);
export type SaleOfferPurpose = z.infer<typeof saleOfferPurposeSchema>;

export const reservationStatusValues = ["secured", "rejected", "released", "expired"] as const;
export const reservationStatusSchema = z.enum(reservationStatusValues);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

export const reservationRejectReasonValues = [
  "sold_out",
  "inventory_not_initialized",
  "quantity_invalid",
  "run_not_accepting_traffic",
  "idempotency_conflict",
] as const;
export const reservationRejectReasonSchema = z.enum(reservationRejectReasonValues);
export type ReservationRejectReason = z.infer<typeof reservationRejectReasonSchema>;

export const reservationDecisionValues = [
  "reservation_secured",
  "sold_out",
  "inventory_not_initialized",
  "idempotent_replay",
  "idempotency_conflict",
  "quantity_invalid",
  "reservation_pending_persistence",
] as const;
export const reservationDecisionSchema = z.enum(reservationDecisionValues);
export type ReservationDecision = z.infer<typeof reservationDecisionSchema>;

export const orderStatusValues = ["queued", "processing", "confirmed", "failed"] as const;
export const orderStatusSchema = z.enum(orderStatusValues);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const erpAttemptStatusValues = ["succeeded", "failed", "timed_out"] as const;
export const erpAttemptStatusSchema = z.enum(erpAttemptStatusValues);
export type ErpAttemptStatus = z.infer<typeof erpAttemptStatusSchema>;

export const orderEventNameValues = [
  "reservation.secured",
  "reservation.rejected",
  "reservation.released",
  "reservation.expired",
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
export type OrderEventName = z.infer<typeof orderEventNameSchema>;

export const simulatedPurchaseStatusValues = [
  "sold_out",
  "reservation_secured",
  "processing",
  "confirmed",
  "failed",
  "reservation_expired",
] as const;
export const simulatedPurchaseStatusSchema = z.enum(simulatedPurchaseStatusValues);
export type SimulatedPurchaseStatus = z.infer<typeof simulatedPurchaseStatusSchema>;

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

export const trafficDeliveryStatusValues = ["complete", "warning", "degraded", "failed"] as const;
export const trafficDeliveryStatusSchema = z.enum(trafficDeliveryStatusValues);
export type TrafficDeliveryStatus = z.infer<typeof trafficDeliveryStatusSchema>;

export const metricNameValues = [
  "traffic.scheduled_request_rate",
  "traffic.latency",
  "traffic.failure_rate",
  "queue.depth",
  "inventory.remaining",
  "inventory.sold_out_rejection",
  "order.consistency_lag",
] as const;
export const metricNameSchema = z.enum(metricNameValues);
export type MetricName = z.infer<typeof metricNameSchema>;

export const queueNameValues = [orderProcessQueueName] as const;
export const queueNameSchema = z.enum(queueNameValues);
export type QueueName = z.infer<typeof queueNameSchema>;
