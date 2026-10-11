import type { InventoryStatus, RunExecutionMode } from "@checkout-surge/contracts";
import { InventoryNotInitializedError } from "@checkout-surge/db";
import { ApiHttpError } from "../runtime/errors.js";

export interface RunInventoryScope {
  runId: string;
  saleOfferId: string;
  executionMode: RunExecutionMode;
}

export interface InventoryStatusReader {
  getStatus: (saleOfferId: string, scope?: RunInventoryScope) => Promise<InventoryStatus>;
}

export class InventoryStatusService {
  constructor(private readonly reader: InventoryStatusReader) {}

  async getStatus(saleOfferId: string, scope?: RunInventoryScope): Promise<InventoryStatus> {
    try {
      return await this.reader.getStatus(saleOfferId, scope);
    } catch (error) {
      if (error instanceof InventoryNotInitializedError) {
        throw new ApiHttpError({
          statusCode: 404,
          code: "inventory_not_initialized",
          message: "Inventory is not initialized for this sale offer.",
          details: { saleOfferId },
        });
      }

      throw error;
    }
  }
}
