import {
  acceptedErpChaosConfigSchema,
  controlServiceTokenHeaderName,
  erpChaosResetPath,
  erpChaosStatusPath,
  erpChaosStatusSchema,
} from "@checkout-surge/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  ErpChaosConfigSafetyError,
  type ErpChaosConfigStore,
} from "../application/chaos-control-service.js";
import { createMockErpErrorPayload } from "../runtime/errors.js";
import type { MockErpFastifyInstance } from "../runtime/fastify.js";

export function registerChaosRoutes(
  app: MockErpFastifyInstance,
  options: {
    chaosConfigStore: ErpChaosConfigStore;
    controlServiceToken: string;
  },
): void {
  app.get(erpChaosStatusPath, async () =>
    erpChaosStatusSchema.parse(options.chaosConfigStore.getStatus()),
  );

  app.put(erpChaosStatusPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    try {
      const nextConfig = acceptedErpChaosConfigSchema.parse(request.body);
      const status = options.chaosConfigStore.update(nextConfig);
      request.log.info({ status }, "Mock ERP chaos controls updated.");
      return erpChaosStatusSchema.parse(status);
    } catch (error) {
      if (error instanceof ErpChaosConfigSafetyError) {
        return reply.status(400).send(
          createMockErpErrorPayload({
            code: "invalid_chaos_configuration",
            message: error.message,
            details: error.details,
            correlationId: request.correlationId,
          }),
        );
      }

      throw error;
    }
  });

  app.post(erpChaosResetPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const status = options.chaosConfigStore.reset();
    request.log.info({ status }, "Mock ERP chaos controls reset.");
    return erpChaosStatusSchema.parse(status);
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

  return reply.status(401).send(
    createMockErpErrorPayload({
      code: "control_token_required",
      message: "A valid control service token is required.",
      correlationId: request.correlationId,
    }),
  );
}
