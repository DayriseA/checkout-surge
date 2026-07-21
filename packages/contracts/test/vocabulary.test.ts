import { describe, expect, it } from "vitest";
import {
  demoPresetVisibilitySchema,
  demoPresetVisibilityValues,
  demoRunReservationOutcomeSchema,
  demoRunReservationOutcomeSourceSchema,
  demoRunReservationOutcomeSourceValues,
  demoRunReservationOutcomeValues,
  demoRunStatusSchema,
  demoRunStatusValues,
  erpAttemptStatusSchema,
  erpAttemptStatusValues,
  eventNameForOrderTransition,
  eventNameForReservationTransition,
  operatorModeSchema,
  operatorModeValues,
  orderEventNameSchema,
  orderEventNameValues,
  orderStatusSchema,
  orderStatusValues,
  recoveryJobStatusSchema,
  recoveryJobStatusValues,
  reservationPendingPersistenceStatusSchema,
  reservationPendingPersistenceStatusValues,
  reservationStatusSchema,
  reservationStatusValues,
  saleOfferPurposeSchema,
  saleOfferPurposeValues,
  simulatedNotificationChannelSchema,
  simulatedNotificationChannelValues,
  simulatedNotificationStatusSchema,
  simulatedNotificationStatusValues,
  trafficCompletionEnrichmentStatusSchema,
  trafficCompletionEnrichmentStatusValues,
  trafficExecutionStatusSchema,
  trafficExecutionStatusValues,
} from "../src/index.js";

describe("shared PostgreSQL vocabulary", () => {
  it("preserves every exact ordered tuple", () => {
    expect(saleOfferPurposeValues).toEqual(["catalog", "generated_run"]);
    expect(reservationStatusValues).toEqual(["secured", "rejected", "released", "expired"]);
    expect(orderStatusValues).toEqual(["queued", "processing", "confirmed", "failed"]);
    expect(erpAttemptStatusValues).toEqual(["succeeded", "failed", "timed_out"]);
    expect(recoveryJobStatusValues).toEqual(["pending", "enqueued", "escalated", "resolved"]);
    expect(orderEventNameValues).toEqual([
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
    ]);
    expect(demoPresetVisibilityValues).toEqual(["public", "admin"]);
    expect(operatorModeValues).toEqual(["public", "admin"]);
    expect(demoRunStatusValues).toEqual(["starting", "active", "draining", "completed", "failed"]);
    expect(trafficExecutionStatusValues).toEqual([
      "not_started",
      "starting",
      "active",
      "succeeded",
      "failed",
    ]);
    expect(trafficCompletionEnrichmentStatusValues).toEqual(["pending", "completed"]);
    expect(reservationPendingPersistenceStatusValues).toEqual([
      "pending_reconciliation",
      "reconciled",
    ]);
    expect(simulatedNotificationChannelValues).toEqual(["email", "sms"]);
    expect(simulatedNotificationStatusValues).toEqual(["recorded"]);
    expect(demoRunReservationOutcomeValues).toEqual(["api_sold_out_decision"]);
    expect(demoRunReservationOutcomeSourceValues).toEqual(["redis", "postgres", "api"]);
  });

  it.each([
    [saleOfferPurposeSchema, saleOfferPurposeValues],
    [reservationStatusSchema, reservationStatusValues],
    [orderStatusSchema, orderStatusValues],
    [erpAttemptStatusSchema, erpAttemptStatusValues],
    [recoveryJobStatusSchema, recoveryJobStatusValues],
    [orderEventNameSchema, orderEventNameValues],
    [demoPresetVisibilitySchema, demoPresetVisibilityValues],
    [operatorModeSchema, operatorModeValues],
    [demoRunStatusSchema, demoRunStatusValues],
    [trafficExecutionStatusSchema, trafficExecutionStatusValues],
    [trafficCompletionEnrichmentStatusSchema, trafficCompletionEnrichmentStatusValues],
    [reservationPendingPersistenceStatusSchema, reservationPendingPersistenceStatusValues],
    [simulatedNotificationChannelSchema, simulatedNotificationChannelValues],
    [simulatedNotificationStatusSchema, simulatedNotificationStatusValues],
    [demoRunReservationOutcomeSchema, demoRunReservationOutcomeValues],
    [demoRunReservationOutcomeSourceSchema, demoRunReservationOutcomeSourceValues],
  ] as const)("derives schema %# from its tuple", (schema, values) => {
    expect(schema.options).toEqual(values);
    for (const value of values) expect(schema.parse(value)).toBe(value);
    expect(schema.safeParse("not-a-member").success).toBe(false);
  });
});

describe("lifecycle event names", () => {
  it("maps every initial or destination status to its event without validating a pair", () => {
    for (const status of reservationStatusValues) {
      expect(eventNameForReservationTransition(status)).toBe(`reservation.${status}`);
    }
    for (const status of orderStatusValues) {
      expect(eventNameForOrderTransition(status)).toBe(`order.${status}`);
    }
  });
});
