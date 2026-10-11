import {
  comparisonDetailParamsSchema,
  comparisonDetailPathTemplate,
  comparisonDetailResponseSchema,
  demoRunOperatorModeHeaderName,
  publicVisitorIdHeaderName,
  startComparisonPath,
  startComparisonRequestSchema,
  startComparisonResponseSchema,
} from "@checkout-surge/contracts";
import { replaceFastifyCorrelation } from "@checkout-surge/logger/fastify";
import type { DashboardSourceResolver } from "../runtime/dashboard-source-identity.js";
import { ApiHttpError } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import {
  createHttpOperationLifecycle,
  OperationDeadlineExceededError,
} from "../runtime/operation-lifecycle.js";
import type { ComparisonReader } from "../services/comparison-read-service.js";
import type { DashboardRecoveryAdmissionController } from "../services/dashboard-recovery-admission.js";
import type { DemoComparisonService } from "../services/demo-comparison-service.js";
import { requireControlServiceToken } from "./control-service-token.js";

export interface RegisterComparisonRoutesOptions {
  comparisonService: Pick<DemoComparisonService, "startComparison">;
  comparisonReader: ComparisonReader;
  admission: DashboardRecoveryAdmissionController;
  sourceResolver: DashboardSourceResolver;
  controlServiceToken: string;
  timeoutMs: number;
  retryAfterSeconds: number;
}

export function registerComparisonRoutes(
  app: ApiFastifyInstance,
  options: RegisterComparisonRoutesOptions,
): void {
  app.post(startComparisonPath, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) return unauthorized;
    if (request.headers[demoRunOperatorModeHeaderName] !== "public") {
      throw new ApiHttpError({
        statusCode: 400,
        code: "invalid_request",
        message: "The fixed comparison requires public admission.",
      });
    }
    const payload = startComparisonRequestSchema.parse(request.body);
    const correlationId = replaceFastifyCorrelation(
      request,
      reply,
      payload.correlationId ?? request.correlationId,
    );
    const credential = request.headers[publicVisitorIdHeaderName];
    const accepted = await options.comparisonService.startComparison(
      Array.isArray(credential) ? credential[0] : credential,
      correlationId,
    );
    const timestamp = new Date().toISOString();
    return reply.status(202).send(
      startComparisonResponseSchema.parse({
        ...accepted,
        recovery: { establishedAt: timestamp },
        correlationId,
        timestamp,
      }),
    );
  });

  app.get(comparisonDetailPathTemplate, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { comparisonId } = comparisonDetailParamsSchema.parse(request.params);
    const credential = request.headers[publicVisitorIdHeaderName];
    const visitorCredential = Array.isArray(credential) ? credential[0] : credential;
    const sourceKey = options.sourceResolver.resolveRecovery({
      ip: request.ip,
      ...(visitorCredential ? { visitorCredential } : {}),
    });
    const lifecycle = createHttpOperationLifecycle({
      request: request.raw,
      response: reply.raw,
      timeoutMs: options.timeoutMs,
    });
    try {
      const permit = await options.admission.admit(sourceKey, lifecycle.signal);
      if (permit.outcome !== "admitted") {
        reply.header("retry-after", String(options.retryAfterSeconds));
        throw new ApiHttpError({
          statusCode: permit.outcome === "rate_limited" ? 429 : 503,
          code:
            permit.outcome === "rate_limited"
              ? "comparison_read_rate_limited"
              : "comparison_read_unavailable",
          message: "Comparison reads are temporarily limited.",
        });
      }
      try {
        const detail = await options.comparisonReader.detail(comparisonId, lifecycle.signal);
        lifecycle.signal.throwIfAborted();
        if (!detail)
          throw new ApiHttpError({
            statusCode: 404,
            code: "resource_not_found",
            message: "Comparison was not found.",
          });
        return reply.status(200).send(comparisonDetailResponseSchema.parse(detail));
      } finally {
        permit.release();
      }
    } catch (error) {
      if (!lifecycle.signal.aborted) throw error;
      if (!(lifecycle.signal.reason instanceof OperationDeadlineExceededError)) return reply;
      reply.header("retry-after", String(options.retryAfterSeconds));
      throw new ApiHttpError({
        statusCode: 503,
        code: "comparison_read_unavailable",
        message: "Comparison read exceeded its response deadline.",
      });
    } finally {
      lifecycle.dispose();
    }
  });
}
