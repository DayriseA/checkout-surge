import { describe, expect, it } from "vitest";
import { parsePersistedBusinessOutcomeSummary } from "../src/services/persisted-demo-run-state.js";

describe("persisted demo-run state", () => {
  it("ignores the retired administrative disposition count", () => {
    expect(
      parsePersistedBusinessOutcomeSummary(
        {
          acceptedReservations: 1,
          reservedUnits: 1,
          soldOutRejections: 0,
          queuedOrders: 0,
          processingOrders: 0,
          retryingOrders: 0,
          confirmedOrders: 1,
          failedOrders: 0,
          businessRejectedOrders: 0,
          technicallyFailedOrders: 0,
          administrativelyDisposedOrders: 0,
          pendingPersistenceCount: 0,
          notificationsRecorded: 1,
        },
        "legacy summary",
      ),
    ).not.toHaveProperty("administrativelyDisposedOrders");
  });
});
