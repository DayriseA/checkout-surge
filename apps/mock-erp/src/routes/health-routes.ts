import { healthResponseSchema, livenessResponseSchema } from "@checkout-surge/contracts";
import { createLivenessPayload, createReadinessResponse } from "@checkout-surge/logger";
import type { MockErpReadiness } from "../application/readiness.js";
import type { MockErpFastifyInstance } from "../runtime/fastify.js";

export interface MockErpHealthRouteOptions {
  readiness: MockErpReadiness;
  startedAt?: Date;
}

export function registerHealthRoutes(
  app: MockErpFastifyInstance,
  options: MockErpHealthRouteOptions,
): void {
  app.get("/health/live", async () =>
    livenessResponseSchema.parse(
      createLivenessPayload({
        service: "mock-erp",
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    ),
  );

  app.get("/health/ready", async (_request, reply) => {
    const response = healthResponseSchema.parse(
      createReadinessResponse({
        service: "mock-erp",
        checks: await options.readiness.checks(),
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    );

    return reply.status(response.status === "unavailable" ? 503 : 200).send(response);
  });
}
