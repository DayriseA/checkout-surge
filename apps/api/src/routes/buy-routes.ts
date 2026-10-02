import {
  type BuyRequest,
  buyOutcomeHeaderName,
  buyRequestSchema,
  buyResponseSchema,
  loadRunIdHeaderName,
  uuidSchema,
} from "@checkout-surge/contracts";
import { replaceFastifyCorrelation } from "@checkout-surge/logger/fastify";
import { ApiHttpError } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { ReserveOrderService } from "../services/reserve-order-service.js";

export interface BuyRouteOptions {
  reserveOrderService: ReserveOrderService;
}

export function registerBuyRoutes(app: ApiFastifyInstance, options: BuyRouteOptions): void {
  app.post("/buy", async (request, reply) => {
    const parsedRequest = buyRequestSchema.parse(request.body);
    const attributedRequest = applyRunAttribution(
      parsedRequest,
      request.headers[loadRunIdHeaderName],
    );
    const correlationId = replaceFastifyCorrelation(
      request,
      reply,
      attributedRequest.correlationId ?? request.correlationId,
    );

    const response = buyResponseSchema.parse(
      await options.reserveOrderService.reserve({
        request: attributedRequest,
        correlationId,
      }),
    );

    const statusCode = buyStatusCode(response.outcome);
    reply.header(buyOutcomeHeaderName, response.outcome);
    if (response.outcome === "reservation_pending_persistence") {
      reply.header("retry-after", response.retryAfterSeconds.toString());
    }
    return reply.status(statusCode).send(response);
  });
}

function applyRunAttribution(
  request: BuyRequest,
  headerValue: string | string[] | undefined,
): BuyRequest {
  const headerRunId = parseLoadRunIdHeader(headerValue);

  if (!headerRunId) {
    return request;
  }

  if (request.runId !== headerRunId) {
    throw new ApiHttpError({
      statusCode: 400,
      code: "invalid_request",
      message: "Run attribution in the request body does not match the load-run header.",
      details: {
        bodyRunId: request.runId,
        headerRunId,
        headerName: loadRunIdHeaderName,
      },
    });
  }

  return request;
}

function parseLoadRunIdHeader(headerValue: string | string[] | undefined): string | undefined {
  if (headerValue === undefined) {
    return undefined;
  }

  if (Array.isArray(headerValue)) {
    if (headerValue.length !== 1) {
      throw new ApiHttpError({
        statusCode: 400,
        code: "invalid_request",
        message: "Load-run attribution header must be provided at most once.",
        details: { headerName: loadRunIdHeaderName },
      });
    }

    return uuidSchema.parse(headerValue[0]);
  }

  return uuidSchema.parse(headerValue);
}

function buyStatusCode(outcome: ReturnType<typeof buyResponseSchema.parse>["outcome"]): number {
  switch (outcome) {
    case "reservation_secured":
    case "reservation_pending_persistence":
      return 202;
    case "inventory_not_initialized":
      return 503;
    case "sold_out":
    case "idempotency_conflict":
    case "run_not_accepting_traffic":
      return 409;
  }
}
