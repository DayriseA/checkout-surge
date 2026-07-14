import {
  adminPresetCopyToCustomPath,
  adminPresetDuplicatePath,
  adminPresetListPath,
  adminPresetSavePath,
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyUpdateRequestSchema,
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
import { correlationIdHeaderName, normalizeCorrelationId } from "@checkout-surge/logger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiHttpError } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import { type DemoRunController, DemoRunValidationError } from "../services/demo-run-service.js";

export interface RegisterDemoRunRoutesOptions {
  demoRunService: DemoRunController;
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
    return reply.status(200).send(await options.demoRunService.getPublicRuntimePolicy());
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
    const correlationId = normalizeCorrelationId(
      parsedRequest.correlationId ?? request.correlationId,
    );
    request.correlationId = correlationId;
    reply.header(correlationIdHeaderName, correlationId);

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

  app.post(adminPresetSavePath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    return reply
      .status(200)
      .send(
        await options.demoRunService.saveAdminPreset(
          saveDemoPresetRequestSchema.parse(request.body),
        ),
      );
  });

  app.post(adminPresetDuplicatePath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    return reply
      .status(201)
      .send(
        await options.demoRunService.duplicatePreset(
          duplicateDemoPresetRequestSchema.parse(request.body),
        ),
      );
  });

  app.post(adminPresetCopyToCustomPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    return reply
      .status(200)
      .send(
        await options.demoRunService.copyPresetToCustom(
          copyDemoPresetToCustomRequestSchema.parse(request.body),
        ),
      );
  });

  app.post(startDemoRunPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) return unauthorized;
    const parsedRequest = startDemoRunRequestSchema.parse(request.body);
    const correlationId = normalizeCorrelationId(
      parsedRequest.correlationId ?? request.correlationId,
    );
    request.correlationId = correlationId;
    reply.header(correlationIdHeaderName, correlationId);

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
    await options.demoRunService.ingestMetrics(parsedRequest);
    return reply.status(202).send({ accepted: true });
  });

  app.post(internalTrafficCompletionPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const parsedReport = trafficCompletionReportSchema.parse(request.body);
    applyInternalBodyCorrelation(request, reply, parsedReport.correlationId);
    await options.demoRunService.recordTrafficCompletion(parsedReport);
    return reply.status(202).send(
      trafficCompletionAcknowledgementSchema.parse({
        runId: parsedReport.runId,
        acknowledged: true,
        correlationId: parsedReport.correlationId,
      }),
    );
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

  return reply.status(401).send({
    code: "control_token_required",
    message: "A valid control service token is required.",
    correlationId: request.correlationId,
    timestamp: new Date().toISOString(),
  });
}

function applyInternalBodyCorrelation(
  request: FastifyRequest,
  reply: FastifyReply,
  correlationId: string,
): void {
  const normalizedCorrelationId = normalizeCorrelationId(correlationId);
  request.correlationId = normalizedCorrelationId;
  reply.header(correlationIdHeaderName, normalizedCorrelationId);
}

function readSingleHeader(request: FastifyRequest, name: string): string | undefined {
  const supplied = request.headers[name];
  return Array.isArray(supplied) ? supplied[0] : supplied;
}

function mapDemoRunError(error: unknown): unknown {
  if (!(error instanceof DemoRunValidationError)) {
    return error;
  }

  const conflictCodes = new Set(["demo_run_already_active", "demo_reset_incomplete"]);
  const notFoundCodes = new Set(["preset_not_found", "public_runtime_policy_not_found"]);
  const forbiddenCodes = new Set(["public_visitor_forbidden"]);

  return new ApiHttpError({
    statusCode: forbiddenCodes.has(error.code)
      ? 403
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
