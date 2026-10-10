import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { correlationIdHeaderName, normalizeCorrelationId } from "./correlation.js";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * Installs one reusable correlation behavior on a Fastify root. Call this
 * immediately after creating the instance and before CORS, error handlers, or
 * route registration.
 *
 * Fastify's generated request id is the normalized inbound correlation value,
 * so request.id, request.log bindings, request.correlationId, and the response
 * header all share the exact same value (normalized or generated exactly once).
 */
export function installFastifyCorrelation<Logger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
  >,
): void {
  app.setGenReqId((req) => normalizeCorrelationId(req.headers[correlationIdHeaderName]));

  app.setChildLoggerFactory(
    (logger, bindings, options) =>
      logger.child({ ...bindings, correlationId: bindings.reqId }, options) as Logger,
  );

  app.addHook("onRequest", async (request, reply) => {
    request.correlationId = request.id;
    reply.header(correlationIdHeaderName, request.correlationId);
  });
}

/**
 * Replaces the request correlation with a validated body-selected value.
 * Updates the request property, response header, and request/reply-scoped
 * loggers together so header, body, and routine logs never diverge. Use this
 * for routes that intentionally promote a validated body correlation over the
 * inbound header (API buy path, demo/admin/history body correlation,
 * load-orchestrator start/abort, Mock ERP confirmation body correlation).
 */
export function replaceFastifyCorrelation(
  request: FastifyRequest,
  reply: FastifyReply,
  correlationId: unknown,
): string {
  const normalized = normalizeCorrelationId(correlationId);
  request.correlationId = normalized;
  request.id = normalized;
  reply.header(correlationIdHeaderName, normalized);
  const rebound = request.server.log.child({ correlationId: normalized, reqId: normalized });
  keepRequestLoggingSwitch(request.log, rebound);
  request.log = rebound;
  reply.log = rebound;
  return normalized;
}

/**
 * Fastify keeps its per-request `disableRequestLogging` decision on the request's own
 * logger, under a private symbol; the rebound logger must carry it to honor that option.
 */
function keepRequestLoggingSwitch(previous: FastifyBaseLogger, rebound: FastifyBaseLogger): void {
  const loggingSwitch = Object.getOwnPropertySymbols(previous).find(
    (symbol) => symbol.description === "fastify.disableRequestLogging",
  );
  if (loggingSwitch) {
    Reflect.set(rebound, loggingSwitch, Reflect.get(previous, loggingSwitch));
  }
}
