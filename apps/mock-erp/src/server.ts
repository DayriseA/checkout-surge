import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { normalizeCorrelationId } from "@checkout-surge/logger";
import { installFastifyCorrelation } from "@checkout-surge/logger/fastify";
import { fastify } from "fastify";
import { ZodError } from "zod";
import type { ErpChaosConfigStore } from "./application/chaos-control-service.js";
import type { ConfirmationService } from "./application/confirmation-service.js";
import { ConfirmationIdempotencyConflictError } from "./application/confirmation-service.js";
import { registerChaosRoutes } from "./routes/chaos-routes.js";
import { registerConfirmationRoutes } from "./routes/confirmation-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { createMockErpErrorPayload } from "./runtime/errors.js";

export interface BuildMockErpServerOptions {
  confirmationService: ConfirmationService;
  chaosConfigStore: ErpChaosConfigStore;
  controlServiceToken: string;
  logger: CheckoutSurgeLogger;
  startedAt?: Date;
}

export function buildMockErpServer(options: BuildMockErpServerOptions) {
  const app = fastify({ loggerInstance: options.logger });

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
          code: "idempotency_conflict",
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
  registerChaosRoutes(app, {
    chaosConfigStore: options.chaosConfigStore,
    controlServiceToken: options.controlServiceToken,
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
