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

    const statusCode = buyStatusCode(response.outcome);
    if (response.outcome === "reservation_pending_persistence") {
      reply.header("retry-after", response.retryAfterSeconds.toString());
    }
    return reply.status(statusCode).send(response);
  });
}

function buyStatusCode(outcome: ReturnType<typeof buyResponseSchema.parse>["outcome"]): number {
  switch (outcome) {
    case "reservation_secured":
    case "idempotent_replay":
    case "reservation_pending_persistence":
      return 202;
    case "quantity_invalid":
      return 400;
    case "inventory_not_initialized":
      return 503;
    case "sold_out":
    case "idempotency_conflict":
      return 409;
  }
}
