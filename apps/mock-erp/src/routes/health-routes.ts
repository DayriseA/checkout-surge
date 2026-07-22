import { healthResponseSchema, livenessResponseSchema } from "@checkout-surge/contracts";
import {
  createLivenessPayload,
  createReadinessCheck,
  createReadinessResponse,
} from "@checkout-surge/logger";
import type { MockErpFastifyInstance } from "../runtime/fastify.js";

export interface MockErpHealthRouteOptions {
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

  app.get("/health/ready", async () =>
    healthResponseSchema.parse(
      createReadinessResponse({
        service: "mock-erp",
        checks: [createReadinessCheck({ name: "confirmation_endpoint_ready", status: "ok" })],
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    ),
  );
}
