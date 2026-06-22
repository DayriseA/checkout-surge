import {
  dashboardEventsPath,
  dashboardRecoveryPath,
  dashboardRecoveryResponseSchema,
} from "@checkout-surge/contracts";
import type { DashboardEventFanout } from "../realtime/dashboard-event-fanout.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";

export interface RegisterDashboardRoutesOptions {
  dashboardEventFanout: DashboardEventFanout;
}

export function registerDashboardRoutes(
  app: ApiFastifyInstance,
  options: RegisterDashboardRoutesOptions,
): void {
  app.get(dashboardRecoveryPath, async () =>
    dashboardRecoveryResponseSchema.parse({
      currentRun: null,
      inventory: null,
      recentMetrics: [],
      queue: null,
      recoveredAt: new Date().toISOString(),
    }),
  );

  app.get(dashboardEventsPath, (request, reply) => {
    reply.hijack();
    options.dashboardEventFanout.connect({
      request: request.raw,
      response: reply.raw,
      correlationId: request.correlationId,
    });
  });
}
