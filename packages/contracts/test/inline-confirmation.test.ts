import { describe, expect, it } from "vitest";
import {
  confirmedOrderSummarySchema,
  failedOrderSummarySchema,
  publicBuyOutcomeValues,
  reservationDecisionValues,
} from "../src/index.js";

describe("inline confirmation contracts", () => {
  it("keeps public confirmation outcomes outside stock decisions", () => {
    expect(reservationDecisionValues).toEqual([
      "reservation_secured",
      "reservation_pending_persistence",
      "sold_out",
      "run_not_accepting_traffic",
      "inventory_not_initialized",
      "idempotency_conflict",
      "idempotent_replay",
    ]);
    expect(publicBuyOutcomeValues).toContain("order_confirmed");
    expect(publicBuyOutcomeValues).toContain("order_confirmation_failed");
  });

  it("requires durable terminal timestamps", () => {
    expect(confirmedOrderSummarySchema.shape.confirmedAt.isOptional()).toBe(false);
    expect(failedOrderSummarySchema.shape.failedAt.isOptional()).toBe(false);
  });
});
