import {
  erpConfirmationLookupParamsSchema,
  erpConfirmationLookupPath,
  erpConfirmationPath,
  erpConfirmationRequestSchema,
  erpConfirmationResponseSchema,
  erpLookupResponseSchema,
  erpReplayedResponseHeaderName,
  erpReplayedResponseHeaderValue,
} from "@checkout-surge/contracts";
import { replaceFastifyCorrelation } from "@checkout-surge/logger/fastify";
import type { ConfirmationService } from "../application/confirmation-service.js";
import type { MockErpFastifyInstance } from "../runtime/fastify.js";

export function registerConfirmationRoutes(
  app: MockErpFastifyInstance,
  options: { confirmationService: ConfirmationService },
): void {
  app.post(erpConfirmationPath, async (request, reply) => {
    const confirmationRequest = erpConfirmationRequestSchema.parse(request.body);
    replaceFastifyCorrelation(request, reply, confirmationRequest.correlationId);

    request.log.info(
      {
        orderId: confirmationRequest.orderId,
        publicOrderId: confirmationRequest.publicOrderId,
        runId: confirmationRequest.runId,
      },
      "Mock ERP confirmation request received.",
    );

    const result = await options.confirmationService.confirm(confirmationRequest);
    const response = erpConfirmationResponseSchema.parse(result.response);
    const statusCode = response.status === "succeeded" ? 200 : (response.httpStatus ?? 503);

    if (result.replayed) {
      reply.header(erpReplayedResponseHeaderName, erpReplayedResponseHeaderValue);
    }
    if (
      response.status === "failed" &&
      (response.errorCode === "erp_capacity_exceeded" ||
        response.errorCode === "erp_forced_outage" ||
        response.errorCode === "erp_injected_error")
    ) {
      reply.header("retry-after", "1");
    }

    request.log.info(
      {
        orderId: confirmationRequest.orderId,
        confirmationStatus: response.status,
        httpStatus: statusCode,
        latencyMs: response.latencyMs,
      },
      "Mock ERP confirmation request completed.",
    );

    return reply.status(statusCode).send(response);
  });

  app.get(erpConfirmationLookupPath, async (request) => {
    const { idempotencyKey } = erpConfirmationLookupParamsSchema.parse(request.params);
    const response = erpLookupResponseSchema.parse(
      await options.confirmationService.lookup(idempotencyKey),
    );
    request.log.info(
      { idempotencyKey, lookupStatus: response.lookup.status },
      "Mock ERP confirmation lookup completed.",
    );
    return response;
  });
}
