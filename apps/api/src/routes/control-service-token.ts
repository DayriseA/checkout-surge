import { controlServiceTokenHeaderName } from "@checkout-surge/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createErrorPayload } from "../runtime/errors.js";

export function requireControlServiceToken(
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
