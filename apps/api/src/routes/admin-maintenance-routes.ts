import {
  adminDemoResetPath,
  adminGeneratedRunTeardownParamsSchema,
  adminGeneratedRunTeardownPathTemplate,
  adminMaintenanceCleanupRunsPath,
  adminMaintenanceCleanupRunsRequestSchema,
  controlServiceTokenHeaderName,
} from "@checkout-surge/contracts";
import { replaceFastifyCorrelation } from "@checkout-surge/logger/fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createErrorPayload } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { AdminDemoResetWorkflow } from "../services/admin-demo-reset-service.js";
import type { GeneratedRunRetentionWorkflow } from "../services/generated-run-retention-service.js";
import type { GeneratedRunTeardownWorkflow } from "../services/generated-run-teardown-service.js";

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

function requireControlServiceToken(
  request: FastifyRequest,
  reply: FastifyReply,
  expectedToken: string,
): FastifyReply | null {
  const suppliedToken = request.headers[controlServiceTokenHeaderName];
  const token = Array.isArray(suppliedToken) ? suppliedToken[0] : suppliedToken;

  if (token === expectedToken) {
    return null;
  }

  return reply.status(401).send(
    createErrorPayload({
      code: "control_token_required",
      message: "A valid control service token is required.",
      correlationId: request.correlationId,
    }),
  );
}
