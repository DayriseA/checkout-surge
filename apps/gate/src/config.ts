import { defaultGuardThresholds, type GuardThresholds } from "./guard.js";

export interface GateConfig {
  host: string;
  port: number;
  /** The Fly app that holds the core Machine. */
  coreAppName: string;
  /** A deploy token for the core app, used to find, start and lease the core Machine. */
  coreFlyApiToken: string;
  /** Where the deploy script writes the core's deployed config, used to recreate the core. */
  coreMachineConfigFile: string;
}

export function loadGateConfig(env: Record<string, string | undefined>): GateConfig {
  return {
    host: env.HOST?.trim() || "::",
    port: Number(env.PORT?.trim() || "8080"),
    coreAppName: required(env, "CORE_FLY_APP"),
    coreFlyApiToken: required(env, "CORE_FLY_API_TOKEN"),
    coreMachineConfigFile: required(env, "CORE_MACHINE_CONFIG_FILE"),
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export interface GuardConfig {
  coreAppName: string;
  /** A deploy token for the core app, shared with the gate. */
  coreFlyApiToken: string;
  runnerAppName: string;
  /** A deploy token for the runner app. */
  runnerFlyApiToken: string;
  dryRun: boolean;
  thresholds: GuardThresholds;
}

/** Thresholds are lowered only to demonstrate a rule on Fly; they default to the design's. */
export function loadGuardConfig(env: Record<string, string | undefined>): GuardConfig {
  const seconds = (name: string, fallback: number) => {
    const value = env[name]?.trim();
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be seconds.`);
    return parsed;
  };
  return {
    coreAppName: required(env, "CORE_FLY_APP"),
    coreFlyApiToken: required(env, "CORE_FLY_API_TOKEN"),
    runnerAppName: required(env, "RUNNER_FLY_APP"),
    runnerFlyApiToken: required(env, "RUNNER_FLY_API_TOKEN"),
    dryRun: env.GUARD_DRY_RUN?.trim() === "true",
    thresholds: {
      coreMaxAwakeSeconds: seconds(
        "GUARD_CORE_MAX_AWAKE_SECONDS",
        defaultGuardThresholds.coreMaxAwakeSeconds,
      ),
      coreStartupGraceSeconds: seconds(
        "GUARD_CORE_STARTUP_GRACE_SECONDS",
        defaultGuardThresholds.coreStartupGraceSeconds,
      ),
      runnerMaxStartedSeconds: seconds(
        "GUARD_RUNNER_MAX_STARTED_SECONDS",
        defaultGuardThresholds.runnerMaxStartedSeconds,
      ),
      leftoverGraceSeconds: seconds(
        "GUARD_LEFTOVER_GRACE_SECONDS",
        defaultGuardThresholds.leftoverGraceSeconds,
      ),
    },
  };
}
