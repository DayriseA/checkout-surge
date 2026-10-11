import { controlServiceTokenHeaderName } from "@checkout-surge/contracts";
import {
  pendingRecoveryPath,
  pendingRecoveryRequestSchema,
  pendingRecoveryResponseSchema,
} from "./api-peer-protocol.js";
import type { PendingPersistenceRecovery } from "./reserve-order-service.js";

/** Direct retries remain owned by the control API, including its permit budget. */
export class HttpPendingPersistenceRecovery implements PendingPersistenceRecovery {
  constructor(private readonly options: { baseUrl: string; controlServiceToken: string }) {}

  async recoverReservation(input: Parameters<PendingPersistenceRecovery["recoverReservation"]>[0]) {
    const response = await fetch(new URL(pendingRecoveryPath, this.options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [controlServiceTokenHeaderName]: this.options.controlServiceToken,
      },
      body: JSON.stringify(pendingRecoveryRequestSchema.parse(input)),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Control pending recovery returned HTTP ${response.status}.`);
    return pendingRecoveryResponseSchema.parse(await response.json()).acceptance;
  }
}
