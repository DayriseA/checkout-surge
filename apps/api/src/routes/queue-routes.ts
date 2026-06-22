import { queueStatusSchema } from "@checkout-surge/contracts";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { QueueStatusService } from "../services/queue-status-service.js";

export interface QueueRouteOptions {
  queueStatusService: QueueStatusService;
}

export function registerQueueRoutes(app: ApiFastifyInstance, options: QueueRouteOptions): void {
  app.get("/queue/status", async (_request, reply) => {
    const response = queueStatusSchema.parse(await options.queueStatusService.getStatus());
    return reply.status(200).send(response);
  });
}
