import {
  adminDeleteRunHistoryRequestSchema,
  controlServiceTokenHeaderName,
  runHistoryListQuerySchema,
  runHistoryPath,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, normalizeCorrelationId } from "@checkout-surge/logger";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { RunHistoryController } from "../services/run-history-service.js";

export interface RegisterRunHistoryRoutesOptions {
  runHistoryService: RunHistoryController;
  controlServiceToken: string;
}

export function registerRunHistoryRoutes(
  app: ApiFastifyInstance,
  options: RegisterRunHistoryRoutesOptions,
): void {
  app.get(runHistoryPath, async (request, reply) => {
    const query = runHistoryListQuerySchema.parse(request.query ?? {});
    return reply.status(200).send(await options.runHistoryService.list(query));
  });

  app.delete(runHistoryPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const parsed = adminDeleteRunHistoryRequestSchema.parse(request.body ?? {});
    const correlationId = normalizeCorrelationId(parsed.correlationId ?? request.correlationId);
    request.correlationId = correlationId;
    reply.header(correlationIdHeaderName, correlationId);

    return reply.status(200).send(await options.runHistoryService.delete(parsed, correlationId));
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

  return reply.status(401).send({
    code: "control_token_required",
    message: "A valid control service token is required.",
    correlationId: request.correlationId,
    timestamp: new Date().toISOString(),
  });
}
