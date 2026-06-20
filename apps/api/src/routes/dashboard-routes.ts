import { dashboardRecoveryResponseSchema } from "@checkout-surge/contracts";
import type { ApiFastifyInstance } from "../runtime/fastify.js";

export function registerDashboardRoutes(app: ApiFastifyInstance): void {
  app.get("/dashboard/recovery", async () =>
    dashboardRecoveryResponseSchema.parse({
      currentRun: null,
      inventory: null,
      recentMetrics: [],
      queue: null,
      recoveredAt: new Date().toISOString(),
    }),
  );
}
