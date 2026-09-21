import {
  adminPresetCopyToCustomPath,
  adminPresetDuplicatePath,
  adminPresetListPath,
  adminPresetSavePath,
  adminPublicRuntimePolicyPath,
  adminPublicRuntimePolicyUpdateRequestSchema,
  archiveAdminPresetRequestSchema,
  copyDemoPresetToCustomRequestSchema,
  demoRunOperatorModeHeaderName,
  duplicateDemoPresetRequestSchema,
  internalLoadMetricIngestPath,
  internalTrafficCompletionPath,
  loadMetricIngestRequestSchema,
  operatorModeSchema,
  previewDemoRunPath,
  previewDemoRunRequestSchema,
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
import { ApiHttpError } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { DemoPresetController } from "../services/demo-preset-service.js";
import type { DemoRunLifecycleController } from "../services/demo-run-service.js";
import type { PublicRuntimePolicyController } from "../services/public-runtime-policy-service.js";
import type { TrafficCompletionController } from "../services/traffic-completion-service.js";
import type { TrafficMetricIngestionController } from "../services/traffic-metric-ingestion-service.js";
import { requireControlServiceToken } from "./control-service-token.js";

export interface RegisterDemoRunRoutesOptions {
  presetService: DemoPresetController;
  runtimePolicyService: PublicRuntimePolicyController;
  demoRunLifecycleService: DemoRunLifecycleController;
  trafficCompletionService: TrafficCompletionController;
  trafficMetricIngestion: TrafficMetricIngestionController;
  controlServiceToken: string;
}

export function registerDemoRunRoutes(
  app: ApiFastifyInstance,
  options: RegisterDemoRunRoutesOptions,
): void {
  app.get(publicPresetListPath, async (_request, reply) => {
    return reply.status(200).send(await options.presetService.listPublicPresets());
  });

  app.get(publicRuntimePolicyPath, async (_request, reply) => {
    return reply.status(200).send(await options.runtimePolicyService.getPublicRuntimePolicy());
  });

  app.get(adminPublicRuntimePolicyPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    return reply
      .status(200)
      .send(await options.runtimePolicyService.getAdminPublicRuntimePolicy(request.correlationId));
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

    return reply
      .status(200)
      .send(
        await options.runtimePolicyService.updateAdminPublicRuntimePolicy(
          parsedRequest,
          correlationId,
        ),
      );
  });

  app.get(adminPresetListPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    return reply.status(200).send(await options.presetService.listAdminPresets());
  });

  app.delete(adminPresetListPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const response = await options.presetService.archiveAdminPreset(
      archiveAdminPresetRequestSchema.parse(request.body),
    );
    return reply.status(200).send(response);
  });

  app.post(adminPresetSavePath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    return reply
      .status(200)
      .send(
        await options.presetService.saveAdminPreset(
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
        await options.presetService.duplicatePreset(
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
        await options.presetService.copyPresetToCustom(
          copyDemoPresetToCustomRequestSchema.parse(request.body),
        ),
      );
  });

  app.post(previewDemoRunPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) return unauthorized;
    const parsedRequest = previewDemoRunRequestSchema.parse(request.body);
    replaceFastifyCorrelation(request, reply, parsedRequest.correlationId ?? request.correlationId);
    return reply.status(200).send(
      await options.demoRunLifecycleService.previewRun({
        ...parsedRequest,
        ...deriveRunStartPrincipal(request),
      }),
    );
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

    return reply.status(202).send(
      await options.demoRunLifecycleService.startRun(
        {
          ...parsedRequest,
          ...deriveRunStartPrincipal(request),
        },
        correlationId,
      ),
    );
  });

  app.post(internalLoadMetricIngestPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const parsedRequest = loadMetricIngestRequestSchema.parse(request.body);
    applyInternalBodyCorrelation(request, reply, parsedRequest.correlationId);
    await options.trafficMetricIngestion.ingest(parsedRequest);
    return reply.status(202).send({ accepted: true });
  });

  app.post(internalTrafficCompletionPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const parsedReport = trafficCompletionReportSchema.parse(request.body);
    applyInternalBodyCorrelation(request, reply, parsedReport.correlationId);
    await options.trafficCompletionService.recordTrafficCompletion(parsedReport);
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
