import type { InventoryStatus } from "@checkout-surge/contracts";
import { InventoryNotInitializedError } from "@checkout-surge/db";
import { describe, expect, it } from "vitest";
import { InventoryStatusService } from "../src/services/inventory-status-service.js";

const saleOfferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projection: InventoryStatus = {
  saleOfferId,
  allocatedStock: 10,
  remainingStock: 4,
  reservedStock: 6,
  pendingPersistenceCount: 0,
  expiredReservationCount: 0,
  oldestPendingPersistenceAgeSeconds: 0,
  reservationThroughput: {
    windowSeconds: 60,
    successfulReservationCount: 5,
    peakRatePerSecond: 5,
    peakWindowSeconds: 1,
    unit: "reservations_per_second",
    measuredAt: "2026-06-20T12:00:30.000Z",
  },
  soldOutPressure: {
    rejectionCount: 3,
    latestObservedAt: "2026-06-20T12:00:29.000Z",
  },
  lastUpdatedAt: "2026-06-20T12:00:00.000Z",
};

describe("InventoryStatusService", () => {
  it("returns the transport-neutral inventory projection unchanged", async () => {
    const service = new InventoryStatusService({ getStatus: async () => projection });

    await expect(service.getStatus(saleOfferId)).resolves.toEqual(projection);
  });

  it("preserves the stable missing-inventory mapping", async () => {
    const service = new InventoryStatusService({
      getStatus: async () => {
        throw new InventoryNotInitializedError(saleOfferId);
      },
    });

    await expect(service.getStatus(saleOfferId)).rejects.toMatchObject({
      statusCode: 404,
      code: "inventory_not_initialized",
      details: { saleOfferId },
    });
  });
});
