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
            ...deriveRunStartPrincipal(request, options.controlServiceToken),
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

    await options.demoRunService.ingestMetrics(loadMetricIngestRequestSchema.parse(request.body));
    return reply.status(202).send({ accepted: true });
  });

  app.post(internalTrafficCompletionPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const run = await options.demoRunService.recordTrafficCompletion(
      trafficCompletionReportSchema.parse(request.body),
    );
    return reply.status(202).send({ run });
  });
}

function deriveRunStartPrincipal(
  request: FastifyRequest,
  expectedToken: string,
): { operatorMode: "public"; publicVisitorId?: string } | { operatorMode: "admin" } {
  const suppliedMode = readSingleHeader(request, demoRunOperatorModeHeaderName);
  const requestedMode = suppliedMode ? operatorModeSchema.parse(suppliedMode) : "public";

  if (requestedMode === "admin") {
    const suppliedToken = readSingleHeader(request, controlServiceTokenHeaderName);
    if (suppliedToken !== expectedToken) {
      throw new ApiHttpError({
        statusCode: 401,
        code: "control_token_required",
        message: "A valid control service token is required for admin demo-run starts.",
      });
    }

    return { operatorMode: "admin" };
  }

  const publicVisitorId = readSingleHeader(request, publicVisitorIdHeaderName);
  return {
    operatorMode: "public",
    ...(publicVisitorId ? { publicVisitorId } : {}),
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

function readSingleHeader(request: FastifyRequest, name: string): string | undefined {
  const supplied = request.headers[name];
  return Array.isArray(supplied) ? supplied[0] : supplied;
}

function mapDemoRunError(error: unknown): unknown {
  if (!(error instanceof DemoRunValidationError)) {
    return error;
  }

  const conflictCodes = new Set(["demo_run_already_active"]);
  const notFoundCodes = new Set(["preset_not_found", "public_runtime_policy_not_found"]);

  return new ApiHttpError({
    statusCode: conflictCodes.has(error.code) ? 409 : notFoundCodes.has(error.code) ? 404 : 400,
    code: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  });
}
