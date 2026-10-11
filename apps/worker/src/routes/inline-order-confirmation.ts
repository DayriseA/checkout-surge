import {
  controlServiceTokenHeaderName,
  type ErrorPayloadCode,
  errorPayloadSchema,
  inlineConfirmationCancelRunPath,
  inlineConfirmationCancelRunSchema,
  inlineConfirmationPath,
  inlineConfirmationRecoveryPath,
  inlineConfirmationRequestSchema,
  inlineConfirmationResultSchema,
  inlineConfirmationStatusPath,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeLogger, correlationIdHeaderName } from "@checkout-surge/logger";
import { replaceFastifyCorrelation } from "@checkout-surge/logger/fastify";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { InlineOrderConfirmation } from "../application/inline-order-confirmation.js";

export function registerInlineOrderConfirmationRoutes(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    CheckoutSurgeLogger
  >,
  options: {
    service: Pick<InlineOrderConfirmation, "confirm" | "status" | "recover" | "cancelRun">;
    controlServiceToken: string;
  },
) {
  const authorize = (request: FastifyRequest, reply: FastifyReply) => {
    replaceFastifyCorrelation(request, reply, request.headers[correlationIdHeaderName]);
    if (request.headers[controlServiceTokenHeaderName] !== options.controlServiceToken) {
      sendError(
        request,
        reply,
        401,
        "control_token_required",
        "A valid control service token is required.",
      );
      return false;
    }
    return true;
  };
  app.post(inlineConfirmationPath, async (request, reply) => {
    if (!authorize(request, reply)) return;
    const parsed = inlineConfirmationRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return sendError(
        request,
        reply,
        400,
        "invalid_request",
        "Invalid inline confirmation request.",
      );
    replaceFastifyCorrelation(request, reply, parsed.data.correlationId);
    const controller = new AbortController();
    const disconnected = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.on("close", disconnected);
    try {
      return inlineConfirmationResultSchema.parse(
        await options.service.confirm(parsed.data, controller.signal),
      );
    } finally {
      reply.raw.removeListener("close", disconnected);
    }
  });
  app.get(inlineConfirmationStatusPath, async (request, reply) => {
    if (!authorize(request, reply)) return;
    const parsed = inlineConfirmationRequestSchema.safeParse(request.query);
    if (!parsed.success)
      return sendError(
        request,
        reply,
        400,
        "invalid_request",
        "Invalid inline confirmation status request.",
      );
    replaceFastifyCorrelation(request, reply, parsed.data.correlationId);
    return inlineConfirmationResultSchema.parse(await options.service.status(parsed.data));
  });
  app.post(inlineConfirmationRecoveryPath, async (request, reply) => {
    if (!authorize(request, reply)) return;
    const parsed = inlineConfirmationRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return sendError(request, reply, 400, "invalid_request", "Invalid inline recovery request.");
    replaceFastifyCorrelation(request, reply, parsed.data.correlationId);
    return inlineConfirmationResultSchema.parse(await options.service.recover(parsed.data));
  });
  app.post(inlineConfirmationCancelRunPath, async (request, reply) => {
    if (!authorize(request, reply)) return;
    const parsed = inlineConfirmationCancelRunSchema.safeParse(request.body);
    if (!parsed.success)
      return sendError(request, reply, 400, "invalid_request", "Invalid run cancellation request.");
    options.service.cancelRun(parsed.data.runId);
    return reply.status(204).send();
  });
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ErrorPayloadCode,
  message: string,
) {
  return reply.status(status).send(
    errorPayloadSchema.parse({
      code,
      message,
      correlationId: request.correlationId,
      timestamp: new Date().toISOString(),
    }),
  );
}
