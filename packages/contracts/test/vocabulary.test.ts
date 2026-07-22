import { describe, expect, it } from "vitest";
import {
  demoPresetVisibilitySchema,
  demoPresetVisibilityValues,
  demoRunStatusSchema,
  demoRunStatusValues,
  erpAttemptStatusSchema,
  erpAttemptStatusValues,
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
  saleOfferPurposeSchema,
  saleOfferPurposeValues,
  trafficCompletionEnrichmentStatusSchema,
  trafficCompletionEnrichmentStatusValues,
  trafficExecutionStatusSchema,
  trafficExecutionStatusValues,
} from "../src/index.js";

describe("shared PostgreSQL vocabulary", () => {
  it("preserves every behavior-bearing ordered tuple", () => {
    expect(saleOfferPurposeValues).toEqual(["catalog", "generated_run"]);
    expect(orderStatusValues).toEqual(["queued", "processing", "confirmed", "failed"]);
    expect(erpAttemptStatusValues).toEqual(["succeeded", "failed", "timed_out"]);
    expect(recoveryJobStatusValues).toEqual(["pending", "enqueued", "escalated", "resolved"]);
    expect(orderEventNameValues).toEqual([
      "reservation.secured",
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
  });

  it.each([
    [saleOfferPurposeSchema, saleOfferPurposeValues],
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
  ] as const)("derives schema %# from its tuple", (schema, values) => {
    expect(schema.options).toEqual(values);
    for (const value of values) expect(schema.parse(value)).toBe(value);
    expect(schema.safeParse("not-a-member").success).toBe(false);
  });
});
