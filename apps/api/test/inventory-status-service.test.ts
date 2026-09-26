import { InventoryNotInitializedError } from "@checkout-surge/db";
import { describe, expect, it } from "vitest";
import { InventoryStatusService } from "../src/services/inventory-status-service.js";

const saleOfferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
describe("InventoryStatusService", () => {
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
