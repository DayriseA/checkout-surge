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

interface TpsWindow {
  windowStartedAtMs: number;
  requestsInWindow: number;
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
  private readonly tpsWindows = new Map<string, TpsWindow>();

  constructor(options: ChaosConfirmationDecisionProviderOptions) {
    this.configStore = options.configStore;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.resolveConfig =
      options.resolveConfig ?? ((request, fallback) => request.erpConfig ?? fallback);
  }

  async decide(request: ErpConfirmationRequest): Promise<ConfirmationDecision> {
    const fallbackConfig = this.configStore.getConfig();
    const config = erpChaosConfigSchema.parse(this.resolveConfig(request, fallbackConfig));

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

    const tpsScopeKey = this.resolveTpsScopeKey(request, config, fallbackConfig);
    if (!this.acceptWithinTpsLimit(tpsScopeKey, config.maxTps)) {
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

  private acceptWithinTpsLimit(scopeKey: string, maxTps: number): boolean {
    const currentWindowStartedAtMs = Math.floor(this.now().getTime() / 1000) * 1000;
    const window = this.tpsWindows.get(scopeKey) ?? {
      windowStartedAtMs: Number.NEGATIVE_INFINITY,
      requestsInWindow: 0,
    };

    if (currentWindowStartedAtMs !== window.windowStartedAtMs) {
      window.windowStartedAtMs = currentWindowStartedAtMs;
      window.requestsInWindow = 0;
    }

    window.requestsInWindow += 1;
    this.tpsWindows.set(scopeKey, window);
    return window.requestsInWindow <= maxTps;
  }

  private resolveTpsScopeKey(
    request: ErpConfirmationRequest,
    config: ErpChaosConfig,
    fallbackConfig: ErpChaosConfig,
  ): string {
    if (request.runId) {
      return `run:${request.runId}`;
    }

    if (!configsMatch(config, fallbackConfig)) {
      return `config:${serializeTpsConfigScope(config)}`;
    }

    return "global";
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

function configsMatch(left: ErpChaosConfig, right: ErpChaosConfig): boolean {
  return (
    left.latencyMs === right.latencyMs &&
    left.maxTps === right.maxTps &&
    left.errorRate === right.errorRate &&
    left.forcedOutage === right.forcedOutage
  );
}

function serializeTpsConfigScope(config: ErpChaosConfig): string {
  return [
    `latencyMs=${config.latencyMs}`,
    `maxTps=${config.maxTps}`,
    `errorRate=${config.errorRate}`,
    `forcedOutage=${config.forcedOutage}`,
  ].join(";");
}
