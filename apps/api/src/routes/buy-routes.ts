import { buyRequestSchema, buyResponseSchema } from "@checkout-surge/contracts";
import { correlationIdHeaderName, normalizeCorrelationId } from "@checkout-surge/logger";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { ReserveOrderService } from "../services/reserve-order-service.js";

export interface BuyRouteOptions {
  reserveOrderService: ReserveOrderService;
}

export function registerBuyRoutes(app: ApiFastifyInstance, options: BuyRouteOptions): void {
  app.post("/buy", async (request, reply) => {
    const parsedRequest = buyRequestSchema.parse(request.body);
    const correlationId = normalizeCorrelationId(
      parsedRequest.correlationId ?? request.correlationId,
    );
    request.correlationId = correlationId;
    reply.header(correlationIdHeaderName, correlationId);

    const response = buyResponseSchema.parse(
      await options.reserveOrderService.reserve({
        request: parsedRequest,
        correlationId,
      }),
    );

    const statusCode = response.outcome === "reservation_secured" ? 202 : 409;
    return reply.status(statusCode).send(response);
  });
}
