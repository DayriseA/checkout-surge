// Fly environments of the deploy tooling. Production is the default and is never checked, so its
// deploy behaves as before. A proof environment comes from a config file (infra/fly/proof.json):
// it must sit in the playground organization, may not name a production app or origin, and each
// of its apps is checked to belong to that organization before every call that acts on it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: operator script, not a Turborepo task.
export const flyctl = process.env.FLYCTL || "flyctl";
const proofOrganization = "playground-416";

export const production = {
  apps: {
    core: "checkout-surge-core",
    runner: "checkout-surge-runner",
    gate: "checkout-surge-gate",
  },
  publicOrigin: "https://checkout-surge-gate.fly.dev",
};

/** Production without a path, else the proof environment of the config file at `path`. */
export function loadEnvironment(path) {
  if (path === undefined) return production;
  const environment = JSON.parse(readFileSync(path, "utf8"));
  if (environment.organization !== proofOrganization) {
    throw new Error(`A proof environment must be in organization ${proofOrganization}.`);
  }
  const productionNames = [...Object.values(production.apps), production.publicOrigin];
  const names = [...Object.values(environment.apps), environment.publicOrigin];
  if (names.some((name) => productionNames.includes(name))) {
    throw new Error("A proof environment may not name a production app or origin; refused.");
  }
  return environment;
}

/** A Machine config file's text, with the environment's app names and public origin. */
export function withEnvironmentNames(text, environment) {
  let named = text.replaceAll(production.publicOrigin, environment.publicOrigin);
  for (const [role, app] of Object.entries(production.apps)) {
    named = named.replaceAll(app, environment.apps[role]);
  }
  return named;
}

/** One Machines API call on `app`, with the operator's flyctl token. */
export async function machinesApiRequest(app, method, path, body, nonce) {
  // Read per call: a token read before the builds was refused (403) once they had finished.
  const token = execFileSync(flyctl, ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const response = await fetch(`https://api.machines.dev/v1/apps/${app}${path}`, {
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
    throw Object.assign(new Error(`${method} ${path} failed with ${response.status}: ${text}`), {
      status: response.status,
    });
  }
  return text ? JSON.parse(text) : undefined;
}

/** Throws unless `app` belongs to the environment's organization. Production is not checked. */
export async function assertInOrganization(environment, app) {
  if (environment === production) return;
  const { organization } = await machinesApiRequest(app, "GET", "");
  if (organization?.slug !== environment.organization) {
    throw new Error(`App ${app} is not in organization ${environment.organization}; refused.`);
  }
}
