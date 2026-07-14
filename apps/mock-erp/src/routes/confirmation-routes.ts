import {
  erpConfirmationPath,
  erpConfirmationRequestSchema,
  erpConfirmationResponseSchema,
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

    const response = erpConfirmationResponseSchema.parse(
      await options.confirmationService.confirm(confirmationRequest),
    );
    const statusCode = response.status === "succeeded" ? 200 : (response.httpStatus ?? 503);

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
}
