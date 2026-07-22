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
import { createHttpOperationLifecycle } from "../runtime/operation-lifecycle.js";
import type { DashboardRecoveryWorkflowController } from "../services/dashboard-recovery-workflow.js";

export interface RegisterDashboardRoutesOptions {
  dashboardEventFanout: Pick<DashboardEventFanout, "connect">;
  dashboardRecoveryWorkflow: DashboardRecoveryWorkflowController;
  sourceResolver: DashboardSourceResolver;
  sseRetryAfterSeconds: number;
  recoveryRetryAfterSeconds: number;
  recoveryTimeoutMs: number;
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
    const lifecycle = createHttpOperationLifecycle({
      request: request.raw,
      response: reply.raw,
      timeoutMs: options.recoveryTimeoutMs,
    });
    try {
      const result = await options.dashboardRecoveryWorkflow.recover({
        sourceKey,
        correlationId: request.correlationId,
        signal: lifecycle.signal,
      });
      if (result.outcome === "recovered") {
        const response = dashboardRecoveryResponseSchema.parse(result.response);
        return reply.status(200).send(response);
      }
      if (result.outcome === "client_disconnected") return reply;

      const atCapacity = result.outcome === "at_capacity";
      const timedOut = result.outcome === "timed_out";
      reply.header("retry-after", options.recoveryRetryAfterSeconds.toString());
      return reply.status(atCapacity || timedOut ? 503 : 429).send(
        createErrorPayload({
          code:
            atCapacity || timedOut
              ? "dashboard_recovery_unavailable"
              : "dashboard_recovery_rate_limited",
          message: atCapacity
            ? "Dashboard recovery is at capacity."
            : timedOut
              ? "Dashboard recovery exceeded its response deadline."
              : "Dashboard recovery request rate exceeded.",
          correlationId: request.correlationId,
          ...(atCapacity || timedOut
            ? {
                details: {
                  reason: atCapacity ? "at_capacity" : "timed_out",
                },
              }
            : {}),
        }),
      );
    } finally {
      lifecycle.dispose();
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
