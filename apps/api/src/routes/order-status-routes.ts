import {
  orderStatusParamsSchema,
  orderStatusRequestSchema,
  orderStatusResponseSchema,
} from "@checkout-surge/contracts";
import { ApiHttpError } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { OrderStatusController } from "../services/order-status-service.js";

export interface OrderStatusRouteOptions {
  orderStatusService: OrderStatusController;
}

export function registerOrderStatusRoutes(
  app: ApiFastifyInstance,
  options: OrderStatusRouteOptions,
): void {
  app.get("/orders/:publicOrderId/status", async (request, reply) => {
    const { publicOrderId } = orderStatusParamsSchema.parse(request.params ?? {});
    orderStatusRequestSchema.parse({
      publicOrderId,
      correlationId: request.correlationId,
    });
    const status = await options.orderStatusService.getStatus({
      publicOrderId,
      correlationId: request.correlationId,
    });

    if (!status) {
      throw new ApiHttpError({
        statusCode: 404,
        code: "order_not_found",
        message: "Order status was not found",
        details: { publicOrderId },
      });
    }

    return reply.status(200).send(orderStatusResponseSchema.parse(status));
  });
}
