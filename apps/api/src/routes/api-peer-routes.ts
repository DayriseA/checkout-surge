import type { ApiFastifyInstance } from "../runtime/fastify.js";
import {
  buyerTimingFlushPath,
  buyerTimingFlushRequestSchema,
  buyerTimingFlushResponseSchema,
  pendingRecoveryPath,
  pendingRecoveryRequestSchema,
  pendingRecoveryResponseSchema,
} from "../services/api-peer-protocol.js";
import type { PendingPersistenceRecovery } from "../services/reserve-order-service.js";
import { requireControlServiceToken } from "./control-service-token.js";

export function registerPendingRecoveryRoute(
  app: ApiFastifyInstance,
  options: {
    controlServiceToken: string;
    recovery: PendingPersistenceRecovery;
  },
): void {
  app.post(pendingRecoveryPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) return unauthorized;
    const input = pendingRecoveryRequestSchema.parse(request.body);
    return pendingRecoveryResponseSchema.parse({
      acceptance: await options.recovery.recoverReservation(input),
    });
  });
}

export function registerBuyerTimingFlushRoute(
  app: ApiFastifyInstance,
  options: {
    controlServiceToken: string;
    prepare?(runId: string): Promise<{
      bootId: string;
      mergeFailureGeneration: number;
      activatedRunId: string;
      timingAvailable: boolean;
    }>;
    flush(runId: string): Promise<{ bootId: string; mergeFailureGeneration: number }>;
  },
): void {
  app.post(buyerTimingFlushPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) return unauthorized;
    const { runId, activate } = buyerTimingFlushRequestSchema.parse(request.body);
    if (activate) {
      if (!options.prepare) throw new Error("Buyer activation is unavailable.");
      return buyerTimingFlushResponseSchema.parse(await options.prepare(runId));
    }
    return buyerTimingFlushResponseSchema.parse(await options.flush(runId));
  });
}
