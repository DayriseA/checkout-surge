import { healthResponseSchema, livenessResponseSchema } from "@checkout-surge/contracts";
import { createLivenessPayload, createReadinessResponse } from "@checkout-surge/logger";
import type { MockErpFastifyInstance } from "../runtime/fastify.js";

export function registerHealthRoutes(
  app: MockErpFastifyInstance,
  options: { startedAt?: Date },
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
        checks: [{ name: "confirmation_endpoint_ready", status: "ok" }],
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    );

    return reply.status(200).send(response);
  });
}
