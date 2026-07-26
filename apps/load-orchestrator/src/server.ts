import {
  controlServiceTokenHeaderName,
  type ErrorPayloadCode,
  errorPayloadSchema,
  healthReadyPath,
  healthResponseSchema,
  livenessResponseSchema,
  trafficExecutionAbortPath,
  trafficExecutionAbortRequestSchema,
  trafficExecutionAbortResponseSchema,
  trafficExecutionStartPath,
  trafficExecutionStartRequestSchema,
  trafficExecutionStartResponseSchema,
  trafficExecutionStatusResponseSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeLogger,
  createLivenessPayload,
  createReadinessResponse,
  normalizeCorrelationId,
} from "@checkout-surge/logger";
import {
  installFastifyCorrelation,
  replaceFastifyCorrelation,
} from "@checkout-surge/logger/fastify";
import { type FastifyReply, type FastifyRequest, fastify } from "fastify";
import { ZodError } from "zod";
import { ExecutionConflictError } from "./application/execution-store.js";
import {
  ExecutionSlotConflictError,
  TrafficTerminationUnconfirmedError,
} from "./application/k6-runner.js";
import {
  TrafficAbortConflictError,
  type TrafficExecutionService,
} from "./application/traffic-execution-service.js";
import type { LoadOrchestratorConfig } from "./runtime/config.js";
import type { LoadOrchestratorReadiness } from "./runtime/readiness.js";

export interface BuildLoadOrchestratorServerOptions {
  config: LoadOrchestratorConfig;
  logger: CheckoutSurgeLogger;
  readiness: LoadOrchestratorReadiness;
  trafficExecutionService: TrafficExecutionService;
  startedAt?: Date;
}

export function buildLoadOrchestratorServer(options: BuildLoadOrchestratorServerOptions) {
  const app = fastify({ loggerInstance: options.logger });

  installFastifyCorrelation(app);

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId ?? normalizeCorrelationId(undefined);

    if (error instanceof ZodError) {
      return reply.status(400).send(
        errorPayload("invalid_request", "Request validation failed.", correlationId, {
          issues: error.issues,
        }),
      );
    }

    if (
      error instanceof ExecutionConflictError ||
      error instanceof TrafficAbortConflictError ||
      error instanceof ExecutionSlotConflictError
    ) {
      return reply.status(409).send(
        errorPayload("traffic_execution_conflict", error.message, correlationId, {
          currentRunId: error.currentRunId,
        }),
      );
    }
    if (error instanceof TrafficTerminationUnconfirmedError)
      return reply
        .status(503)
        .send(errorPayload("traffic_termination_unconfirmed", error.message, correlationId));

    request.log.error({ err: error }, "Unhandled load-orchestrator error.");
    return reply
      .status(500)
      .send(
        errorPayload(
          "internal_error",
          "The load orchestrator could not complete the request.",
          correlationId,
        ),
      );
  });

  app.get("/health/live", async () =>
    livenessResponseSchema.parse(
      createLivenessPayload({
        service: "load-orchestrator",
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    ),
  );

  app.get(healthReadyPath, async (_request, reply) => {
    const response = healthResponseSchema.parse(
      createReadinessResponse({
        service: "load-orchestrator",
        checks: await options.readiness.checks(),
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      }),
    );

    return reply.status(response.status === "unavailable" ? 503 : 200).send(response);
  });

  app.post(trafficExecutionStartPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(
      request,
      reply,
      options.config.controlServiceToken,
    );
    if (unauthorized) {
      return unauthorized;
    }

    const startRequest = trafficExecutionStartRequestSchema.parse(request.body);
    replaceFastifyCorrelation(request, reply, startRequest.correlationId);
    const response = trafficExecutionStartResponseSchema.parse(
      await options.trafficExecutionService.start(startRequest),
    );
    return reply.status(202).send(response);
  });

  app.post(trafficExecutionAbortPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(
      request,
      reply,
      options.config.controlServiceToken,
    );
    if (unauthorized) return unauthorized;
    const parsed = trafficExecutionAbortRequestSchema.parse(request.body ?? {});
    const correlationId = replaceFastifyCorrelation(
      request,
      reply,
      parsed.correlationId ?? request.correlationId,
    );
    return reply
      .status(200)
      .send(
        trafficExecutionAbortResponseSchema.parse(
          await options.trafficExecutionService.abortCurrent({ ...parsed, correlationId }),
        ),
      );
  });

  app.get<{ Params: { runId: string } }>("/traffic/status/:runId", async (request, reply) => {
    const unauthorized = requireControlServiceToken(
      request,
      reply,
      options.config.controlServiceToken,
    );
    if (unauthorized) return unauthorized;
    const snapshot = await options.trafficExecutionService.statusSnapshot(request.params.runId);
    return trafficExecutionStatusResponseSchema.parse({
      runId: request.params.runId,
      ...snapshot,
      correlationId: request.correlationId,
      observedAt: new Date().toISOString(),
    });
  });

  return app;
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

  return reply
    .status(401)
    .send(
      errorPayload(
        "control_token_required",
        "A valid control service token is required.",
        request.correlationId,
      ),
    );
}

function errorPayload(
  code: ErrorPayloadCode,
  message: string,
  correlationId: string,
  details?: Record<string, unknown>,
) {
  return errorPayloadSchema.parse({
    code,
    message,
    correlationId,
    timestamp: new Date().toISOString(),
    ...(details ? { details } : {}),
  });
}
