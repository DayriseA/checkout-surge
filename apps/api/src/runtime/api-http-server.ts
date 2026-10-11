import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { normalizeCorrelationId } from "@checkout-surge/logger";
import { installFastifyCorrelation } from "@checkout-surge/logger/fastify";
import cors from "@fastify/cors";
import { type FastifyReply, type FastifyRequest, fastify } from "fastify";
import { ZodError } from "zod";
import { DemoRunValidationError } from "../services/demo-run-validation-error.js";
import type { ApiConfig } from "./config.js";
import { ApiHttpError, createErrorPayload } from "./errors.js";
import type { ApiFastifyInstance } from "./fastify.js";

export async function buildApiHttpServer(options: {
  config: ApiConfig;
  logger: CheckoutSurgeLogger;
}): Promise<ApiFastifyInstance> {
  const app = fastify({
    loggerInstance: options.logger,
    // Fastify's two lines per request flood the log under load; failures are logged below.
    disableRequestLogging: true,
    trustProxy: options.config.trustedProxyCidrs,
  }) as ApiFastifyInstance;

  installFastifyCorrelation(app);
  app.addHook("onResponse", logFailedResponse);

  await app.register(cors, {
    origin: options.config.webOrigins.length > 0 ? options.config.webOrigins : true,
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId ?? normalizeCorrelationId(undefined);

    if (error instanceof ApiHttpError) {
      return sendError(reply, error.statusCode, {
        code: error.code,
        message: error.message,
        correlationId,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    if (error instanceof DemoRunValidationError) {
      const retryAfterSeconds = publicRunBudgetRetryAfterSeconds(error);
      return sendError(
        reply,
        demoRunValidationStatus(error.code),
        {
          code: error.code,
          message: error.message,
          correlationId,
          ...(error.details ? { details: error.details } : {}),
        },
        retryAfterSeconds === undefined ? undefined : { "retry-after": String(retryAfterSeconds) },
      );
    }

    if (error instanceof ZodError) {
      return sendError(reply, 400, {
        code: "invalid_request",
        message: "Request validation failed.",
        correlationId,
        details: { issues: error.issues },
      });
    }

    if (isBadRequestError(error)) {
      return sendError(reply, 400, {
        code: "invalid_request",
        message: error.message || "Request validation failed.",
        correlationId,
      });
    }

    request.log.error({ err: error }, "Unhandled API error.");

    return sendError(reply, 500, {
      code: "internal_error",
      message: "The API could not complete the request.",
      correlationId,
    });
  });

  return app;
}

/**
 * Logs one line per failed response. A 409 is a business answer (sold out, or a run or
 * preset conflict) that a load run can receive at request rate, so it is not logged.
 */
async function logFailedResponse(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { statusCode } = reply;
  if (statusCode < 400 || statusCode === 409) return;
  const details = {
    method: request.method,
    url: request.url,
    statusCode,
    responseTimeMs: reply.elapsedTime,
  };
  if (statusCode >= 500) {
    request.log.error(details, "Request failed.");
  } else {
    request.log.warn(details, "Request rejected.");
  }
}

function demoRunValidationStatus(code: DemoRunValidationError["code"]): number {
  if (code === "public_visitor_forbidden") return 403;
  if (code === "public_run_budget_exceeded") return 429;
  if (code === "resource_not_found") return 404;
  if (["run_conflict", "preset_conflict", "traffic_report_rejected"].includes(code)) return 409;
  return 400;
}

function isBadRequestError(error: unknown): error is Error & { statusCode: 400 } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 400
  );
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  options: Parameters<typeof createErrorPayload>[0],
  headers?: Record<string, string>,
) {
  if (headers) {
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  }
  const payload = createErrorPayload(options);
  return reply.status(statusCode).send(payload);
}

function publicRunBudgetRetryAfterSeconds(error: DemoRunValidationError): number | undefined {
  if (error.code !== "public_run_budget_exceeded") return undefined;
  return error.retryAfterSeconds;
}
