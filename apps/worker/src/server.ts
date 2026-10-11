import {
  healthReadyPath,
  healthResponseSchema,
  livenessResponseSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeLogger,
  createLivenessPayload,
  createReadinessResponse,
} from "@checkout-surge/logger";
import { fastify } from "fastify";
import { registerInlineOrderConfirmationRoutes } from "./routes/inline-order-confirmation.js";
import type { WorkerReadiness } from "./runtime/readiness.js";

export interface BuildWorkerHealthServerOptions {
  logger: CheckoutSurgeLogger;
  readiness: WorkerReadiness;
  startedAt?: Date;
  inlineConfirmation?: Parameters<typeof registerInlineOrderConfirmationRoutes>[1];
}

export function buildWorkerHealthServer(options: BuildWorkerHealthServerOptions) {
  const app = fastify({ loggerInstance: options.logger });
  if (options.inlineConfirmation)
    registerInlineOrderConfirmationRoutes(app, options.inlineConfirmation);

  app.get("/health/live", async () =>
    livenessResponseSchema.parse(
      createLivenessPayload({
        service: "worker",
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    ),
  );

  app.get(healthReadyPath, async (_request, reply) => {
    const response = healthResponseSchema.parse(
      createReadinessResponse({
        service: "worker",
        checks: await options.readiness.checks(),
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    );

    return reply.status(response.status === "unavailable" ? 503 : 200).send(response);
  });

  return app;
}

export type WorkerHealthServer = ReturnType<typeof buildWorkerHealthServer>;
