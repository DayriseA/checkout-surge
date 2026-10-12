#!/usr/bin/env node
// Creates, deploys or destroys the proof environment of infra/fly/proof.json. Every flyctl call
// names its app or organization, and every call on an existing app follows a check that the app
// belongs to the proof organization (environment.mjs).
//
// Usage, from anywhere:
//   node infra/fly/proof.mjs create    new apps, the gate's public addresses, fresh secrets
//   node infra/fly/proof.mjs deploy [deploy.mjs options]   `deploy.mjs all` on the proof apps
//   node infra/fly/proof.mjs destroy   the apps, with their Machines, volumes, tokens and secrets
// `create` starts from scratch: after a failed create, destroy, then create again. It keeps a copy
// of the core's secrets, admin passphrase included, in infra/fly/proof-core.env, which git and the
// build context ignore, and never prints a secret.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertInOrganization, flyctl, loadEnvironment } from "./environment.mjs";

const configPath = fileURLToPath(new URL("proof.json", import.meta.url));
const secretsPath = fileURLToPath(new URL("proof-core.env", import.meta.url));
const environment = loadEnvironment(configPath);
const { apps, organization } = environment;

function fly(args, input) {
  return execFileSync(flyctl, args, { encoding: "utf8", input });
}

/** Runs flyctl on `app`, once the app is checked to belong to the proof organization. */
async function flyOnApp(app, args, input) {
  await assertInOrganization(environment, app);
  return fly([...args, "--app", app], input);
}

const randomHex = (bytes) => randomBytes(bytes).toString("hex");
const envFile = (values) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");

async function create() {
  for (const app of Object.values(apps)) fly(["apps", "create", app, "--org", organization]);
  await flyOnApp(apps.gate, ["ips", "allocate-v4", "--shared"]);
  await flyOnApp(apps.gate, ["ips", "allocate-v6"]);
  // One deploy token per app, shared by its holders; production has one per holder.
  const token = async (role) =>
    (await flyOnApp(apps[role], ["tokens", "create", "deploy", "--name", `proof-${role}`])).trim();
  const coreToken = await token("core");
  const runnerToken = await token("runner");
  const control = randomHex(32);
  const postgres = randomHex(24);
  const redis = randomHex(24);
  const core = {
    CONTROL_SERVICE_TOKEN: control,
    ADMIN_DASHBOARD_PASSPHRASE: randomHex(16),
    ADMIN_SESSION_SECRET: randomHex(32),
    PUBLIC_CLIENT_COOKIE_SECRET: randomHex(32),
    POSTGRES_PASSWORD: postgres,
    DATABASE_URL: `postgresql://postgres:${postgres}@127.0.0.1:5432/checkout_surge`,
    REDIS_PASSWORD: redis,
    REDIS_URL: `redis://:${redis}@127.0.0.1:6379`,
    RUNNER_FLY_API_TOKEN: runnerToken,
    CORE_FLY_API_TOKEN: coreToken,
  };
  writeFileSync(secretsPath, envFile(core), { mode: 0o600 });
  const secrets = {
    core,
    runner: { CONTROL_SERVICE_TOKEN: control },
    gate: { CORE_FLY_API_TOKEN: coreToken, RUNNER_FLY_API_TOKEN: runnerToken },
  };
  for (const [role, values] of Object.entries(secrets)) {
    await flyOnApp(apps[role], ["secrets", "import", "--stage"], envFile(values));
  }
}

function deploy() {
  const deployScript = fileURLToPath(new URL("deploy.mjs", import.meta.url));
  const options = process.argv.slice(3);
  execFileSync(process.execPath, [deployScript, "all", "--environment", configPath, ...options], {
    stdio: "inherit",
  });
}

async function destroy() {
  for (const app of Object.values(apps)) {
    try {
      await assertInOrganization(environment, app);
    } catch (error) {
      if (error.status === 404) continue; // Already destroyed.
      throw error;
    }
    fly(["apps", "destroy", app, "--yes"]);
  }
  rmSync(secretsPath, { force: true });
}

const action = { create, deploy, destroy }[process.argv[2]];
if (!action) {
  console.error("Usage: node infra/fly/proof.mjs <create|deploy|destroy> [deploy.mjs options]");
  process.exit(64);
}
try {
  await action();
  console.log(`Proof environment: ${process.argv[2]} done.`);
} catch (error) {
  // The message only: a failed call's captured output could hold a token.
  console.error(error.message);
  process.exitCode = 1;
}
