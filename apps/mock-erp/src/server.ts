import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { normalizeCorrelationId } from "@checkout-surge/logger";
import { installFastifyCorrelation } from "@checkout-surge/logger/fastify";
import { fastify } from "fastify";
import { ZodError } from "zod";
import type { ConfirmationService } from "./application/confirmation-service.js";
import { ConfirmationIdempotencyConflictError } from "./application/confirmation-service.js";
import { registerConfirmationRoutes } from "./routes/confirmation-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { createMockErpErrorPayload } from "./runtime/errors.js";

export interface BuildMockErpServerOptions {
  confirmationService: ConfirmationService;
  logger: CheckoutSurgeLogger;
  startedAt?: Date;
}

export function buildMockErpServer(options: BuildMockErpServerOptions) {
  const app = fastify({
    loggerInstance: options.logger,
    routerOptions: { maxParamLength: 200 },
    // Finish already-connected calls through the normal protocol while closing;
    // Fastify's generic shutdown 503 is not a valid ERP lookup response.
    return503OnClosing: false,
  });

  installFastifyCorrelation(app);

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId ?? normalizeCorrelationId(undefined);

    if (error instanceof ZodError || isBadRequestError(error)) {
      return reply.status(400).send(
        createMockErpErrorPayload({
          code: "invalid_request",
          message: "Request validation failed.",
          correlationId,
          ...(error instanceof ZodError ? { details: { issues: error.issues } } : {}),
        }),
      );
    }

    if (error instanceof ConfirmationIdempotencyConflictError) {
      return reply.status(409).send(
        createMockErpErrorPayload({
          code: "erp_idempotency_conflict",
          message: error.message,
          correlationId,
        }),
      );
    }

    request.log.error({ err: error }, "Unhandled Mock ERP error.");
    return reply.status(500).send(
      createMockErpErrorPayload({
        code: "internal_error",
        message: "The Mock ERP could not complete the request.",
        correlationId,
      }),
    );
  });

  registerHealthRoutes(app, {
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  });
  registerConfirmationRoutes(app, { confirmationService: options.confirmationService });

  return app;
}

function isBadRequestError(error: unknown): error is Error & { statusCode: 400 } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 400
  );
}
