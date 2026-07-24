import {
  adminDemoResetPath,
  adminGeneratedRunTeardownParamsSchema,
  adminGeneratedRunTeardownPathTemplate,
  adminMaintenanceCleanupRunsPath,
  adminMaintenanceCleanupRunsRequestSchema,
} from "@checkout-surge/contracts";
import { replaceFastifyCorrelation } from "@checkout-surge/logger/fastify";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { AdminDemoResetWorkflow } from "../services/admin-demo-reset-service.js";
import type { GeneratedRunRetentionWorkflow } from "../services/generated-run-retention-service.js";
import type { GeneratedRunTeardownWorkflow } from "../services/generated-run-teardown-service.js";
import { requireControlServiceToken } from "./control-service-token.js";

export interface RegisterAdminMaintenanceRoutesOptions {
  adminDemoReset: AdminDemoResetWorkflow;
  generatedRunRetention: GeneratedRunRetentionWorkflow;
  generatedRunTeardown: GeneratedRunTeardownWorkflow;
  controlServiceToken: string;
}

export function registerAdminMaintenanceRoutes(
  app: ApiFastifyInstance,
  options: RegisterAdminMaintenanceRoutesOptions,
): void {
  app.post(adminDemoResetPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    return reply.status(200).send(await options.adminDemoReset.reset(request.correlationId));
  });

  app.post(adminMaintenanceCleanupRunsPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const parsed = adminMaintenanceCleanupRunsRequestSchema.parse(request.body ?? {});
    const correlationId = replaceFastifyCorrelation(
      request,
      reply,
      parsed.correlationId ?? request.correlationId,
    );

    return reply.status(200).send(
      await options.generatedRunRetention.cleanupOldRuns({
        keepLatest: parsed.keepLatest,
        olderThanDays: parsed.olderThanDays,
        correlationId,
      }),
    );
  });

  app.delete(adminGeneratedRunTeardownPathTemplate, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) return unauthorized;
    const { runId } = adminGeneratedRunTeardownParamsSchema.parse(request.params);
    const correlationId = replaceFastifyCorrelation(request, reply, request.correlationId);
    return reply
      .status(200)
      .send(await options.generatedRunTeardown.teardownGeneratedRun({ runId, correlationId }));
  });
}
