import { type ErpChaosConfig, erpChaosConfigSchema } from "@checkout-surge/contracts";
import type { ErpChaosSafetyCaps } from "../application/chaos-control-service.js";

export interface MockErpConfig {
  host: string;
  port: number;
  controlServiceToken: string;
  defaultChaosConfig: ErpChaosConfig;
  chaosSafetyCaps: ErpChaosSafetyCaps;
}

const unsafeControlServiceTokens = new Set([
  "change-me-shared-control-token",
  "change-me-control-service-token",
]);

export function loadMockErpConfig(env: NodeJS.ProcessEnv): MockErpConfig {
  return {
    host: env.HOST?.trim() || "0.0.0.0",
    port: parsePositiveInteger(env.PORT, "PORT", 4100),
    controlServiceToken: requireEnv(env, "CONTROL_SERVICE_TOKEN"),
    defaultChaosConfig: erpChaosConfigSchema.parse({
      latencyMs: parseNonnegativeInteger(env.LATENCY_MS, "LATENCY_MS", 0),
      maxTps: parsePositiveInteger(env.MAX_TPS, "MAX_TPS", 100),
      errorRate: parsePercentage(env.ERROR_RATE, "ERROR_RATE", 0),
      forcedOutage: parseBoolean(env.FORCED_OUTAGE, "FORCED_OUTAGE", false),
    }),
    chaosSafetyCaps: {
      maxLatencyMs: parseNonnegativeInteger(env.ADMIN_MAX_LATENCY_MS, "ADMIN_MAX_LATENCY_MS", 5000),
      minMaxTps: parsePositiveInteger(env.ADMIN_MIN_MAX_TPS, "ADMIN_MIN_MAX_TPS", 1),
      maxErrorRate: parsePercentage(env.ADMIN_MAX_ERROR_RATE, "ADMIN_MAX_ERROR_RATE", 1),
      allowForcedOutage: parseBoolean(
        env.ADMIN_ALLOW_FORCED_OUTAGE,
        "ADMIN_ALLOW_FORCED_OUTAGE",
        true,
      ),
    },
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  if (name === "CONTROL_SERVICE_TOKEN" && unsafeControlServiceTokens.has(value)) {
    throw new Error(`${name} must be replaced with a deployment-specific secret.`);
  }

  return value;
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  const raw = value?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parseNonnegativeInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const raw = value?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }

  return parsed;
}

function parsePercentage(value: string | undefined, name: string, fallback: number): number {
  const raw = value?.trim();

  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number from 0 to 1.`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  const raw = value?.trim().toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }

  throw new Error(`${name} must be true or false.`);
}
