import { readFileSync } from "node:fs";

export const production = {
  name: "production",
  organization: "personal",
  apps: {
    core: "checkout-surge-core",
    runner: "checkout-surge-runner",
    gate: "checkout-surge-gate",
  },
  publicOrigin: "https://checkout-surge-gate.fly.dev",
};

export function loadEnvironment(path) {
  if (!path) return production;
  const environment = JSON.parse(readFileSync(path, "utf8"));
  if (environment.name !== "proof" || environment.organization !== "playground-416") {
    throw new Error("A proof config must name proof and organization playground-416.");
  }
  const names = Object.keys(production.apps).map((role) => environment.apps?.[role]);
  if (
    Object.values(environment.apps ?? {}).some((name) =>
      Object.values(production.apps).includes(name),
    )
  ) {
    throw new Error("Production apps are forbidden in a proof configuration.");
  }
  if (
    names.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9-]{2,62}$/.test(name)) ||
    Object.keys(environment.apps ?? {}).length !== names.length ||
    new Set(names).size !== names.length
  ) {
    throw new Error("Configure three distinct Fly app names.");
  }
  const origin = new URL(environment.publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== environment.publicOrigin ||
    origin.origin === production.publicOrigin
  ) {
    throw new Error("Configure a proof HTTPS public origin, without a path or credentials.");
  }
  return environment;
}

export async function verifyApps(environment, request, allowMissing = false) {
  const existing = new Set();
  for (const app of Object.values(environment.apps)) {
    let details;
    try {
      details = await request("GET", app, "");
    } catch (error) {
      if (allowMissing && error.status === 404) continue;
      throw error;
    }
    if (details.organization?.slug !== environment.organization) {
      throw new Error(
        `App ${app} does not belong to ${environment.organization}; refusing changes.`,
      );
    }
    existing.add(app);
  }
  return existing;
}

// Apply before embedding recovery configs: both the live and nested configs use these names.
export function configureMachine(config, environment) {
  for (const holder of [config, ...(config.containers ?? [])]) {
    if (!holder.env) continue;
    if ("CORE_FLY_APP" in holder.env) holder.env.CORE_FLY_APP = environment.apps.core;
    if ("RUNNER_FLY_APP" in holder.env) holder.env.RUNNER_FLY_APP = environment.apps.runner;
    if ("LOAD_ORCHESTRATOR_BASE_URL" in holder.env) {
      holder.env.LOAD_ORCHESTRATOR_BASE_URL = `http://${environment.apps.runner}.internal:4200`;
    }
    if ("WEB_ORIGIN" in holder.env) holder.env.WEB_ORIGIN = environment.publicOrigin;
  }
  return config;
}

export function createAppRequest(run, flyctl, fetchRequest = fetch) {
  return async (method, app, path = "", body, nonce) => {
    const token = run(flyctl, ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
    const response = await fetchRequest(`https://api.machines.dev/v1/apps/${app}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(nonce ? { "fly-machine-lease-nonce": nonce } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(
        new Error(`${method} ${app}${path} failed with ${response.status}: ${text}`),
        {
          status: response.status,
        },
      );
    }
    return text ? JSON.parse(text) : undefined;
  };
}
