import { defaultGuardThresholds, type GuardThresholds } from "./guard.js";

export interface GateConfig {
  stores?: { appName: string; token: string; organization: string; lifecycleToken: string };
  recoveryRegion?: string;
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
    ...(env.STORES_FLY_APP
      ? {
          stores: {
            ...loadStoresConfig(env),
            lifecycleToken: required(env, "GATE_LIFECYCLE_TOKEN"),
          },
          recoveryRegion: "cdg",
        }
      : {}),
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
  stores?: { appName: string; token: string; organization: string };
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
    ...(env.STORES_FLY_APP ? { stores: loadStoresConfig(env) } : {}),
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

function loadStoresConfig(env: Record<string, string | undefined>) {
  const organization = required(env, "EXPECTED_FLY_ORGANIZATION");
  if (organization !== "playground-416")
    throw new Error("Remote stores are restricted to the proof organization.");
  const names = [env.CORE_FLY_APP, env.RUNNER_FLY_APP, env.STORES_FLY_APP].filter(Boolean);
  if (names.some((name) => name?.startsWith("checkout-surge-")))
    throw new Error("Production apps cannot use proof stores lifecycle.");
  return {
    appName: required(env, "STORES_FLY_APP"),
    token: required(env, "STORES_FLY_API_TOKEN"),
    organization,
  };
}
