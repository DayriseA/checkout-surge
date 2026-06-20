import { inventoryStatusSchema, uuidSchema } from "@checkout-surge/contracts";
import { z } from "zod";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { InventoryStatusService } from "../services/inventory-status-service.js";

const inventoryStatusParamsSchema = z.object({ saleOfferId: uuidSchema }).strict();

export interface InventoryRouteOptions {
  inventoryStatusService: InventoryStatusService;
}

export function registerInventoryRoutes(
  app: ApiFastifyInstance,
  options: InventoryRouteOptions,
): void {
  app.get("/inventory/:saleOfferId/status", async (request, reply) => {
    const { saleOfferId } = inventoryStatusParamsSchema.parse(request.params);
    const response = inventoryStatusSchema.parse(
      await options.inventoryStatusService.getStatus(saleOfferId),
    );

    return reply.status(200).send(response);
  });
}
