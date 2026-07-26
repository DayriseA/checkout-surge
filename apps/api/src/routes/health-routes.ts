import {
  healthReadyPath,
  healthResponseSchema,
  livenessResponseSchema,
} from "@checkout-surge/contracts";
import { createLivenessPayload, createReadinessResponse } from "@checkout-surge/logger";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { ApiReadiness } from "../runtime/readiness.js";

export interface HealthRouteOptions {
  readiness: ApiReadiness;
  startedAt?: Date;
}

export function registerHealthRoutes(app: ApiFastifyInstance, options: HealthRouteOptions): void {
  app.get("/health/live", async () =>
    livenessResponseSchema.parse(
      createLivenessPayload({
        service: "api",
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    ),
  );

  app.get(healthReadyPath, async (_request, reply) => {
    const response = healthResponseSchema.parse(
      createReadinessResponse({
        service: "api",
        checks: await options.readiness.checks(),
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    );

    return reply.status(response.status === "unavailable" ? 503 : 200).send(response);
  });
}
