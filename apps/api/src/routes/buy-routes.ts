import {
  type BuyRequest,
  type BuyResponse,
  buyOutcomeHeaderName,
  buyRequestSchema,
  buyResponseSchema,
  loadRunIdHeaderName,
  uuidSchema,
} from "@checkout-surge/contracts";
import { replaceFastifyCorrelation } from "@checkout-surge/logger/fastify";
import { ApiHttpError } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import {
  postgresStockBuyPathPrefix,
  synchronousConfirmationBuyPathPrefix,
} from "../services/comparison-runs.js";
import type { PostgresStockBuyService } from "../services/postgres-stock-buy-service.js";
import type { ReserveOrderService } from "../services/reserve-order-service.js";
import type { SynchronousConfirmationBuyService } from "../services/synchronous-confirmation-buy-service.js";

export interface BuyRouteOptions {
  reserveOrderService: ReserveOrderService;
  synchronousConfirmationBuyService: SynchronousConfirmationBuyService;
  postgresStockBuyService: Pick<PostgresStockBuyService, "buy">;
}

type Buy = (input: { request: BuyRequest; correlationId: string }) => Promise<BuyResponse>;

export function registerBuyRoutes(app: ApiFastifyInstance, options: BuyRouteOptions): void {
  registerBuyRoute(app, "/buy", (input) => options.reserveOrderService.reserve(input));
  // The runner of a run without the order queue targets this route (see buyTargetBaseUrl).
  registerBuyRoute(app, `${synchronousConfirmationBuyPathPrefix}/buy`, (input) =>
    options.synchronousConfirmationBuyService.buy(input),
  );
  // The runner of a run whose stock PostgreSQL decides targets this route.
  registerBuyRoute(app, `${postgresStockBuyPathPrefix}/buy`, (input) =>
    options.postgresStockBuyService.buy(input),
  );
}

function registerBuyRoute(app: ApiFastifyInstance, path: string, buy: Buy): void {
  app.post(path, async (request, reply) => {
    const parsedRequest = buyRequestSchema.parse(request.body);
    assertRunHeaderAgreement(parsedRequest, request.headers[loadRunIdHeaderName]);
    const correlationId = replaceFastifyCorrelation(
      request,
      reply,
      parsedRequest.correlationId ?? request.correlationId,
    );

    const response = buyResponseSchema.parse(await buy({ request: parsedRequest, correlationId }));

    const statusCode = buyStatusCode(response.outcome);
    reply.header(buyOutcomeHeaderName, response.outcome);
    if (response.outcome === "reservation_pending_persistence") {
      reply.header("retry-after", response.retryAfterSeconds.toString());
    }
    return reply.status(statusCode).send(response);
  });
}

function assertRunHeaderAgreement(
  request: BuyRequest,
  headerValue: string | string[] | undefined,
): void {
  const headerRunId = parseLoadRunIdHeader(headerValue);

  if (!headerRunId) {
    return;
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
    case "order_confirmed":
      return 200;
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
