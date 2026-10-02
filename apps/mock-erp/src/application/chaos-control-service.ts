import { type ErpConfirmationRequest, erpChaosConfigSchema } from "@checkout-surge/contracts";
import type { ConfirmationDecision, ConfirmationDecisionProvider } from "./confirmation-service.js";
import type { TpsLimiter } from "./tps-limiter.js";

export interface ChaosConfirmationDecisionProviderOptions {
  tpsLimiter: TpsLimiter;
  random?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}

export class ChaosConfirmationDecisionProvider implements ConfirmationDecisionProvider {
  private readonly tpsLimiter: TpsLimiter;
  private readonly random: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  constructor(options: ChaosConfirmationDecisionProviderOptions) {
    this.tpsLimiter = options.tpsLimiter;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async decide(request: ErpConfirmationRequest): Promise<ConfirmationDecision> {
    const config = erpChaosConfigSchema.parse(request.erpConfig);

    if (config.forcedOutage) {
      return dependencyFailure(
        503,
        "erp_forced_outage",
        "The ERP forced-outage diagnostic control is enabled.",
      );
    }

    const tpsScopeKey = `run:${request.runId}`;
    if (!this.tpsLimiter.acquire(tpsScopeKey, config.maxTps)) {
      return dependencyFailure(
        429,
        "erp_capacity_exceeded",
        "The ERP cannot accept more confirmations right now.",
      );
    }

    if (config.latencyMs > 0) {
      await this.sleep(config.latencyMs);
    }

    if (config.errorRate > 0 && this.random() < config.errorRate) {
      return dependencyFailure(
        503,
        "erp_injected_error",
        "The ERP injected a configured dependency failure.",
      );
    }

    return { status: "succeeded" };
  }
}

function dependencyFailure(
  httpStatus: number,
  errorCode: string,
  errorMessage: string,
): ConfirmationDecision {
  return {
    status: "failed",
    httpStatus,
    errorCode,
    errorMessage,
  };
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
