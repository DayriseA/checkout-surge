import {
  erpResilienceStatusPath,
  sharedErpProtectionStatusSchema,
} from "@checkout-surge/contracts";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { SharedErpProtectionService } from "../services/erp-status-service.js";

export interface ErpRouteOptions {
  sharedErpProtectionService: Pick<SharedErpProtectionService, "getStatus">;
}

export function registerErpRoutes(app: ApiFastifyInstance, options: ErpRouteOptions): void {
  app.get(erpResilienceStatusPath, async (_request, reply) => {
    const response = sharedErpProtectionStatusSchema.parse(
      await options.sharedErpProtectionService.getStatus(),
    );
    return reply.status(200).send(response);
  });
}
