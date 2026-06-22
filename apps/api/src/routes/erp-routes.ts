import { erpResilienceStatusPath, erpResilienceStatusSchema } from "@checkout-surge/contracts";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { ErpStatusService } from "../services/erp-status-service.js";

export interface ErpRouteOptions {
  erpStatusService: ErpStatusService;
}

export function registerErpRoutes(app: ApiFastifyInstance, options: ErpRouteOptions): void {
  app.get(erpResilienceStatusPath, async (_request, reply) => {
    const response = erpResilienceStatusSchema.parse(await options.erpStatusService.getStatus());
    return reply.status(200).send(response);
  });
}
