import {
  adminPresetCopyToCustomPath,
  adminPresetDuplicatePath,
  adminPresetListPath,
  adminPresetSavePath,
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyUpdateRequestSchema,
  archiveAdminPresetRequestSchema,
  controlServiceTokenHeaderName,
  copyDemoPresetToCustomRequestSchema,
  demoRunOperatorModeHeaderName,
  duplicateDemoPresetRequestSchema,
  internalLoadMetricIngestPath,
  internalTrafficCompletionPath,
  loadMetricIngestRequestSchema,
  operatorModeSchema,
  publicPresetListPath,
  publicRuntimePolicyPath,
  publicVisitorIdHeaderName,
  saveDemoPresetRequestSchema,
  startDemoRunPath,
  startDemoRunRequestSchema,
  trafficCompletionAcknowledgementSchema,
  trafficCompletionReportSchema,
} from "@checkout-surge/contracts";
import { replaceFastifyCorrelation } from "@checkout-surge/logger/fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiHttpError, createErrorPayload } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { DemoRunController } from "../services/demo-run-service.js";
import { DemoRunValidationError } from "../services/demo-run-validation-error.js";
import type { TrafficMetricIngestionController } from "../services/traffic-metric-ingestion-service.js";

export interface RegisterDemoRunRoutesOptions {
  demoRunService: DemoRunController;
  trafficMetricIngestion: TrafficMetricIngestionController;
  controlServiceToken: string;
}

export function registerDemoRunRoutes(
  app: ApiFastifyInstance,
  options: RegisterDemoRunRoutesOptions,
): void {
  app.get(publicPresetListPath, async (_request, reply) => {
    return reply.status(200).send(await options.demoRunService.listPublicPresets());
  });

  app.get(publicRuntimePolicyPath, async (_request, reply) => {
    try {
      return reply.status(200).send(await options.demoRunService.getPublicRuntimePolicy());
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });

  app.get(adminPublicRuntimePolicyPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    try {
      return reply
        .status(200)
        .send(await options.demoRunService.getAdminPublicRuntimePolicy(request.correlationId));
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });

  app.put(adminPublicRuntimePolicyPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const parsedRequest = adminPublicRuntimePolicyUpdateRequestSchema.parse(request.body);
    const correlationId = replaceFastifyCorrelation(
      request,
      reply,
      parsedRequest.correlationId ?? request.correlationId,
    );

    try {
      return reply
        .status(200)
        .send(
          await options.demoRunService.updateAdminPublicRuntimePolicy(parsedRequest, correlationId),
        );
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });

  app.get(adminPresetListPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    return reply.status(200).send(await options.demoRunService.listAdminPresets());
  });

  app.delete(adminPresetListPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    try {
      const response = await options.demoRunService.archiveAdminPreset(
        archiveAdminPresetRequestSchema.parse(request.body),
      );
      return reply.status(200).send(response);
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });

  app.post(adminPresetSavePath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    try {
      return reply
        .status(200)
        .send(
          await options.demoRunService.saveAdminPreset(
            saveDemoPresetRequestSchema.parse(request.body),
          ),
        );
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });

  app.post(adminPresetDuplicatePath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    try {
      return reply
        .status(201)
        .send(
          await options.demoRunService.duplicatePreset(
            duplicateDemoPresetRequestSchema.parse(request.body),
          ),
        );
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });

  app.post(adminPresetCopyToCustomPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    try {
      return reply
        .status(200)
        .send(
          await options.demoRunService.copyPresetToCustom(
            copyDemoPresetToCustomRequestSchema.parse(request.body),
          ),
        );
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });

  app.post(startDemoRunPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) return unauthorized;
    const parsedRequest = startDemoRunRequestSchema.parse(request.body);
    const correlationId = replaceFastifyCorrelation(
      request,
      reply,
      parsedRequest.correlationId ?? request.correlationId,
    );

    try {
      return reply.status(202).send(
        await options.demoRunService.startRun(
          {
            ...parsedRequest,
            ...deriveRunStartPrincipal(request),
          },
          correlationId,
        ),
      );
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });

  app.post(internalLoadMetricIngestPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const parsedRequest = loadMetricIngestRequestSchema.parse(request.body);
    applyInternalBodyCorrelation(request, reply, parsedRequest.correlationId);
    try {
      await options.trafficMetricIngestion.ingest(parsedRequest);
      return reply.status(202).send({ accepted: true });
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });

  app.post(internalTrafficCompletionPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const parsedReport = trafficCompletionReportSchema.parse(request.body);
    applyInternalBodyCorrelation(request, reply, parsedReport.correlationId);
    try {
      await options.demoRunService.recordTrafficCompletion(parsedReport);
      return reply.status(202).send(
        trafficCompletionAcknowledgementSchema.parse({
          runId: parsedReport.runId,
          acknowledged: true,
          correlationId: parsedReport.correlationId,
        }),
      );
    } catch (error) {
      throw mapDemoRunError(error);
    }
  });
}

function deriveRunStartPrincipal(
  request: FastifyRequest,
): { operatorMode: "public"; publicVisitorCredential?: string } | { operatorMode: "admin" } {
  const suppliedMode = readSingleHeader(request, demoRunOperatorModeHeaderName);
  if (!suppliedMode) {
    throw new ApiHttpError({
      statusCode: 400,
      code: "operator_mode_required",
      message: "An operator mode assertion is required.",
    });
  }
  const requestedMode = operatorModeSchema.parse(suppliedMode);

  if (requestedMode === "admin") return { operatorMode: "admin" };

  const publicVisitorCredential = readSingleHeader(request, publicVisitorIdHeaderName);
  return {
    operatorMode: "public",
    ...(publicVisitorCredential ? { publicVisitorCredential } : {}),
  };
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

function applyInternalBodyCorrelation(
  request: FastifyRequest,
  reply: FastifyReply,
  correlationId: string,
): void {
  replaceFastifyCorrelation(request, reply, correlationId);
}

function readSingleHeader(request: FastifyRequest, name: string): string | undefined {
  const supplied = request.headers[name];
  return Array.isArray(supplied) ? supplied[0] : supplied;
}

function mapDemoRunError(error: unknown): unknown {
  if (!(error instanceof DemoRunValidationError)) {
    return error;
  }

  const conflictCodes = new Set(["run_conflict", "preset_conflict", "traffic_report_rejected"]);
  const notFoundCodes = new Set(["resource_not_found"]);
  const forbiddenCodes = new Set(["public_visitor_forbidden"]);
  const rateLimitedCodes = new Set(["public_run_budget_exceeded"]);

  return new ApiHttpError({
    statusCode: forbiddenCodes.has(error.code)
      ? 403
      : rateLimitedCodes.has(error.code)
        ? 429
        : conflictCodes.has(error.code)
          ? 409
          : notFoundCodes.has(error.code)
            ? 404
            : 400,
    code: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  });
}
