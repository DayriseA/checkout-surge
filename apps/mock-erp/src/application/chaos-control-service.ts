import {
  type ErpChaosConfig,
  type ErpChaosStatus,
  type ErpConfirmationRequest,
  erpChaosConfigSchema,
  erpChaosStatusSchema,
} from "@checkout-surge/contracts";
import type { ConfirmationDecision, ConfirmationDecisionProvider } from "./confirmation-service.js";

export interface ErpChaosSafetyCaps {
  maxLatencyMs: number;
  minMaxTps: number;
  maxErrorRate: number;
  allowForcedOutage: boolean;
}

export class ErpChaosConfigSafetyError extends Error {
  override readonly name = "ErpChaosConfigSafetyError";

  constructor(readonly details: Record<string, unknown>) {
    super("ERP chaos config exceeds the configured safety caps.");
  }
}

export class ErpChaosConfigStore {
  private readonly defaultConfig: ErpChaosConfig;
  private current: ErpChaosConfig;
  private updatedAt: Date;

  constructor(
    initialConfig: ErpChaosConfig,
    private readonly safetyCaps: ErpChaosSafetyCaps,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.defaultConfig = erpChaosConfigSchema.parse(initialConfig);
    this.current = this.defaultConfig;
    this.updatedAt = this.now();
    this.validateAgainstCaps(this.current);
  }

  getConfig(): ErpChaosConfig {
    return { ...this.current };
  }

  getStatus(): ErpChaosStatus {
    return erpChaosStatusSchema.parse({
      ...this.current,
      updatedAt: this.updatedAt.toISOString(),
    });
  }

  update(nextConfig: ErpChaosConfig): ErpChaosStatus {
    const parsed = erpChaosConfigSchema.parse(nextConfig);
    this.validateAgainstCaps(parsed);
    this.current = parsed;
    this.updatedAt = this.now();
    return this.getStatus();
  }

  reset(): ErpChaosStatus {
    return this.update(this.defaultConfig);
  }

  private validateAgainstCaps(config: ErpChaosConfig): void {
    const violations: Record<string, unknown> = {};

    if (config.latencyMs > this.safetyCaps.maxLatencyMs) {
      violations.latencyMs = {
        maximum: this.safetyCaps.maxLatencyMs,
        actual: config.latencyMs,
      };
    }
    if (config.maxTps < this.safetyCaps.minMaxTps) {
      violations.maxTps = {
        minimum: this.safetyCaps.minMaxTps,
        actual: config.maxTps,
      };
    }
    if (config.errorRate > this.safetyCaps.maxErrorRate) {
      violations.errorRate = {
        maximum: this.safetyCaps.maxErrorRate,
        actual: config.errorRate,
      };
    }
    if (config.forcedOutage && !this.safetyCaps.allowForcedOutage) {
      violations.forcedOutage = {
        allowed: false,
        actual: true,
      };
    }

    if (Object.keys(violations).length > 0) {
      throw new ErpChaosConfigSafetyError(violations);
    }
  }
}

export interface ChaosConfirmationDecisionProviderOptions {
  configStore: ErpChaosConfigStore;
  now?: () => Date;
  random?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
  resolveConfig?: (request: ErpConfirmationRequest, fallback: ErpChaosConfig) => ErpChaosConfig;
}

export class ChaosConfirmationDecisionProvider implements ConfirmationDecisionProvider {
  private readonly configStore: ErpChaosConfigStore;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly resolveConfig: (
    request: ErpConfirmationRequest,
    fallback: ErpChaosConfig,
  ) => ErpChaosConfig;
  private windowStartedAtMs = Number.NEGATIVE_INFINITY;
  private requestsInWindow = 0;

  constructor(options: ChaosConfirmationDecisionProviderOptions) {
    this.configStore = options.configStore;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.resolveConfig = options.resolveConfig ?? ((_request, fallback) => fallback);
  }

  async decide(request: ErpConfirmationRequest): Promise<ConfirmationDecision> {
    const config = erpChaosConfigSchema.parse(
      this.resolveConfig(request, this.configStore.getConfig()),
    );

    if (config.latencyMs > 0) {
      await this.sleep(config.latencyMs);
    }

    if (config.forcedOutage) {
      return dependencyFailure(
        503,
        "erp_forced_outage",
        "The ERP forced-outage diagnostic control is enabled.",
      );
    }

    if (!this.acceptWithinTpsLimit(config.maxTps)) {
      return dependencyFailure(
        429,
        "erp_capacity_exceeded",
        "The ERP cannot accept more confirmations right now.",
      );
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

  private acceptWithinTpsLimit(maxTps: number): boolean {
    const currentWindowStartedAtMs = Math.floor(this.now().getTime() / 1000) * 1000;

    if (currentWindowStartedAtMs !== this.windowStartedAtMs) {
      this.windowStartedAtMs = currentWindowStartedAtMs;
      this.requestsInWindow = 0;
    }

    this.requestsInWindow += 1;
    return this.requestsInWindow <= maxTps;
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
