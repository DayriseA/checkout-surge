export interface GateConfig {
  host: string;
  port: number;
  /** The Fly app that holds the core Machine. */
  coreAppName: string;
  /** A deploy token for the core app, used to find, start and lease the core Machine. */
  coreFlyApiToken: string;
}

export function loadGateConfig(env: Record<string, string | undefined>): GateConfig {
  return {
    host: env.HOST?.trim() || "::",
    port: Number(env.PORT?.trim() || "8080"),
    coreAppName: required(env, "CORE_FLY_APP"),
    coreFlyApiToken: required(env, "CORE_FLY_API_TOKEN"),
  };
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
