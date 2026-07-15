import {
  dashboardEventsPath,
  dashboardRecoveryPath,
  dashboardRecoveryResponseSchema,
  publicVisitorIdHeaderName,
} from "@checkout-surge/contracts";
import type { DashboardEventFanout } from "../realtime/dashboard-event-fanout.js";
import type { DashboardSourceResolver } from "../runtime/dashboard-source-identity.js";
import { createErrorPayload } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { DashboardRecoveryAdmissionController } from "../services/dashboard-recovery-admission.js";
import type { DashboardRecoveryService } from "../services/dashboard-recovery-service.js";

export interface RegisterDashboardRoutesOptions {
  dashboardEventFanout: DashboardEventFanout;
  dashboardRecoveryService: DashboardRecoveryService;
  dashboardRecoveryAdmission: DashboardRecoveryAdmissionController;
  sourceResolver: DashboardSourceResolver;
  sseRetryAfterSeconds: number;
  recoveryRetryAfterSeconds: number;
}

export function registerDashboardRoutes(
  app: ApiFastifyInstance,
  options: RegisterDashboardRoutesOptions,
): void {
  app.get(dashboardRecoveryPath, async (request, reply) => {
    const rawCredential = request.headers[publicVisitorIdHeaderName];
    const visitorCredential = Array.isArray(rawCredential) ? rawCredential[0] : rawCredential;
    const sourceKey = options.sourceResolver.resolveRecovery({
      ip: request.ip,
      ...(visitorCredential ? { visitorCredential } : {}),
    });
    const admission = await options.dashboardRecoveryAdmission.admit(sourceKey);
    if (admission.outcome !== "admitted") {
      const atCapacity = admission.outcome === "at_capacity";
      reply.header("retry-after", options.recoveryRetryAfterSeconds.toString());
      return reply.status(atCapacity || admission.outcome === "unavailable" ? 503 : 429).send(
        createErrorPayload({
          code: atCapacity
            ? "dashboard_recovery_at_capacity"
            : admission.outcome === "unavailable"
              ? "dashboard_recovery_limiter_unavailable"
              : "dashboard_recovery_rate_limited",
          message: atCapacity
            ? "Dashboard recovery is at capacity."
            : admission.outcome === "unavailable"
              ? "Dashboard recovery admission is temporarily unavailable."
              : "Dashboard recovery request rate exceeded.",
          correlationId: request.correlationId,
        }),
      );
    }
    try {
      const response = dashboardRecoveryResponseSchema.parse(
        await options.dashboardRecoveryService.getRecovery({ correlationId: request.correlationId }),
      );
      return reply.status(200).send(response);
    } finally {
      admission.release();
    }
  });

  app.get(dashboardEventsPath, (request, reply) => {
    const admission = options.dashboardEventFanout.connect({
      request: request.raw,
      response: reply.raw,
      correlationId: request.correlationId,
      sourceKey: options.sourceResolver.resolveSse(request.ip),
      onAccepted: () => reply.hijack(),
    });
    if (admission !== "connected") {
      const total = admission === "total_capacity";
      reply.header("retry-after", options.sseRetryAfterSeconds.toString());
      return reply.status(total ? 503 : 429).send(
        createErrorPayload({
          code: total ? "dashboard_sse_at_capacity" : "dashboard_sse_source_limit_exceeded",
          message: total
            ? "Dashboard realtime is at capacity."
            : "Dashboard realtime source connection limit exceeded.",
          correlationId: request.correlationId,
        }),
      );
    }
  });
}
