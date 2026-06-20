import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { correlationIdHeaderName, normalizeCorrelationId } from "@checkout-surge/logger";
import cors from "@fastify/cors";
import { type FastifyReply, fastify } from "fastify";
import { ZodError } from "zod";
import { registerBuyRoutes } from "./routes/buy-routes.js";
import { registerDashboardRoutes } from "./routes/dashboard-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import type { ApiConfig } from "./runtime/config.js";
import { ApiHttpError, createErrorPayload } from "./runtime/errors.js";
import type { ApiFastifyInstance } from "./runtime/fastify.js";
import type { ApiReadiness } from "./runtime/readiness.js";
import type { ReserveOrderService } from "./services/reserve-order-service.js";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

export interface BuildApiServerOptions {
  config: ApiConfig;
  logger: CheckoutSurgeLogger;
  readiness: ApiReadiness;
  reserveOrderService: ReserveOrderService;
  startedAt?: Date;
}

export async function buildApiServer(options: BuildApiServerOptions): Promise<ApiFastifyInstance> {
  const app = fastify({
    loggerInstance: options.logger,
  }) as ApiFastifyInstance;

  await app.register(cors, {
    origin: options.config.webOrigins.length > 0 ? options.config.webOrigins : true,
  });

  app.addHook("onRequest", async (request, reply) => {
    request.correlationId = normalizeCorrelationId(request.headers[correlationIdHeaderName]);
    reply.header(correlationIdHeaderName, request.correlationId);
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId ?? normalizeCorrelationId(undefined);

    if (error instanceof ApiHttpError) {
      return sendError(reply, error.statusCode, {
        code: error.code,
        message: error.message,
        correlationId,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    if (error instanceof ZodError) {
      return sendError(reply, 400, {
        code: "invalid_request",
        message: "Request validation failed.",
        correlationId,
        details: { issues: error.issues },
      });
    }

    if (isBadRequestError(error)) {
      return sendError(reply, 400, {
        code: "invalid_request",
        message: error.message || "Request validation failed.",
        correlationId,
      });
    }

    request.log.error({ err: error, correlationId }, "Unhandled API error.");

    return sendError(reply, 500, {
      code: "internal_error",
      message: "The API could not complete the request.",
      correlationId,
    });
  });

  registerHealthRoutes(app, {
    readiness: options.readiness,
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  });
  registerBuyRoutes(app, { reserveOrderService: options.reserveOrderService });
  registerDashboardRoutes(app);

  return app;
}

function isBadRequestError(error: unknown): error is Error & { statusCode: 400 } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 400
  );
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  options: Parameters<typeof createErrorPayload>[0],
) {
  const payload = createErrorPayload(options);
  return reply.status(statusCode).send(payload);
}
