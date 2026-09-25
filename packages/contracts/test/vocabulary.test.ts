import { describe, expect, it } from "vitest";
import {
  demoPresetVisibilityValues,
  demoRunStatusValues,
  erpAttemptStatusValues,
  operatorModeValues,
  orderEventNameValues,
  orderFailureCategoryValues,
  orderStatusValues,
  orderWaitingReasonValues,
  recoveryJobStatusValues,
  reservationPendingPersistenceStatusValues,
  saleOfferPurposeValues,
  technicalOrderFailureCodeValues,
  trafficCompletionEnrichmentStatusValues,
  trafficDeliveryStatusValues,
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
      "exhausted",
    ]);
    expect(orderWaitingReasonValues).toEqual([
      "local_admission",
      "erp_capacity",
      "erp_unavailable",
      "uncertain_result",
    ]);
    expect(orderFailureCategoryValues).toEqual(["business_rejection", "technical"]);
    expect(technicalOrderFailureCodeValues).toEqual([
      "erp_authentication_failed",
      "erp_authorization_failed",
      "erp_response_contract_invalid",
      "erp_idempotency_conflict",
      "erp_attempt_contradiction",
      "erp_lookup_identity_contradiction",
      "accepted_run_snapshot_missing",
      "accepted_run_snapshot_invalid",
      "erp_unrecognized_client_error",
    ]);
  });
});

describe("shared traffic delivery vocabulary", () => {
  it("pins the traffic delivery statuses", () => {
    expect(trafficDeliveryStatusValues).toEqual(["complete", "warning", "degraded", "failed"]);
  });
});
