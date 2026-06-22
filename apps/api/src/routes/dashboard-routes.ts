import {
  dashboardEventsPath,
  dashboardRecoveryPath,
  dashboardRecoveryResponseSchema,
} from "@checkout-surge/contracts";
import type { DashboardEventFanout } from "../realtime/dashboard-event-fanout.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { DashboardRecoveryService } from "../services/dashboard-recovery-service.js";

export interface RegisterDashboardRoutesOptions {
  dashboardEventFanout: DashboardEventFanout;
  dashboardRecoveryService: DashboardRecoveryService;
}

export function registerDashboardRoutes(
  app: ApiFastifyInstance,
  options: RegisterDashboardRoutesOptions,
): void {
  app.get(dashboardRecoveryPath, async (_request, reply) => {
    const response = dashboardRecoveryResponseSchema.parse(
      await options.dashboardRecoveryService.getRecovery(),
    );
    return reply.status(200).send(response);
  });

  app.get(dashboardEventsPath, (request, reply) => {
    reply.hijack();
    options.dashboardEventFanout.connect({
      request: request.raw,
      response: reply.raw,
      correlationId: request.correlationId,
    });
  });
}
