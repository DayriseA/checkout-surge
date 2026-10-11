#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAppRequest, loadEnvironment, verifyApps } from "./environment.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function operateProof(action, configPath, { run, request, deploy, secretRoot }) {
  const environment = loadEnvironment(configPath);
  if (environment.name !== "proof")
    throw new Error("The lifecycle command requires a proof config.");
  if (!["create", "deploy", "destroy"].includes(action)) {
    throw new Error("Usage: node infra/fly/proof.mjs <create|deploy|destroy> [config.json]");
  }
  const existing = await verifyApps(environment, request, action !== "deploy");
  const directory = resolve(secretRoot, environment.apps.gate);
  const secretPath = (role) => resolve(directory, `${role}.env`);
  const mutate = async (args, options) => {
    await verifyApps(environment, request, true);
    return run(args, options);
  };
  if (action === "destroy") {
    for (const app of existing) await mutate(["apps", "destroy", app, "--yes"]);
    for (const role of Object.keys(environment.apps)) {
      if (existsSync(secretPath(role))) unlinkSync(secretPath(role));
    }
    if (existsSync(directory)) rmdirSync(directory);
    return;
  }
  if (action === "deploy") {
    for (const role of Object.keys(environment.apps)) {
      if (!existsSync(secretPath(role)))
        throw new Error("Create the proof secrets before deploying.");
    }
    return deploy(configPath);
  }
  // Never silently reset credentials on an existing database. A partial create can be re-run
  // with its saved files; otherwise destroy the disposable apps first.
  const hasSecrets = Object.keys(environment.apps).every((role) => existsSync(secretPath(role)));
  if (existing.size && !hasSecrets) {
    throw new Error(
      "Existing proof apps without complete local secrets; destroy them before creating.",
    );
  }
  if (!existing.size && hasSecrets) {
    throw new Error("Stale local proof secrets; run destroy before recreating.");
  }
  for (const app of Object.values(environment.apps)) {
    if (!existing.has(app)) {
      await mutate(["apps", "create", app, "--org", environment.organization]);
    }
  }
  await verifyApps(environment, request);
  if (!hasSecrets) {
    const secret = () => randomBytes(32).toString("hex");
    const token = async (role, name) =>
      (
        await mutate([
          "tokens",
          "create",
          "deploy",
          "--app",
          environment.apps[role],
          "--name",
          name,
        ])
      ).trim();
    const control = secret();
    const pg = secret();
    const redis = secret();
    const coreToken = await token("core", "proof-core");
    const runnerToken = await token("runner", "proof-runner");
    const values = {
      core: {
        CONTROL_SERVICE_TOKEN: control,
        ADMIN_DASHBOARD_PASSPHRASE: secret(),
        ADMIN_SESSION_SECRET: secret(),
        PUBLIC_CLIENT_COOKIE_SECRET: secret(),
        POSTGRES_PASSWORD: pg,
        DATABASE_URL: `postgresql://postgres:${pg}@127.0.0.1:5432/checkout_surge`,
        REDIS_PASSWORD: redis,
        REDIS_URL: `redis://:${redis}@127.0.0.1:6379`,
        CORE_FLY_API_TOKEN: coreToken,
        RUNNER_FLY_API_TOKEN: runnerToken,
      },
      runner: { CONTROL_SERVICE_TOKEN: control },
      gate: { CORE_FLY_API_TOKEN: coreToken, RUNNER_FLY_API_TOKEN: runnerToken },
    };
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [role, secrets] of Object.entries(values)) {
      const text = Object.entries(secrets)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
      writeFileSync(secretPath(role), `${text}\n`, { mode: 0o600, flag: "wx" });
    }
  }
  for (const [role, app] of Object.entries(environment.apps)) {
    await mutate(["secrets", "import", "--stage", "--app", app], {
      input: readFileSync(secretPath(role), "utf8"),
    });
  }
  // The CLI reports existing addresses; re-running create only allocates missing families.
  const addresses = JSON.parse(run(["ips", "list", "--app", environment.apps.gate, "--json"]));
  for (const family of ["v4", "v6"]) {
    if (!addresses.some((address) => address.Type === family || address.type === family)) {
      await mutate([
        "ips",
        `allocate-${family}`,
        ...(family === "v4" ? ["--shared"] : []),
        "--app",
        environment.apps.gate,
      ]);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: operator script, not a Turborepo task.
  const flyctl = process.env.FLYCTL || "flyctl";
  const run = (command, args, options = {}) => {
    try {
      return execFileSync(command, args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        ...options,
      });
    } catch {
      // In particular, do not print execFileSync's captured token or secrets-import streams.
      throw new Error(`Command failed: ${command} ${args.join(" ")}`);
    }
  };
  try {
    const configPath = resolve(process.argv[3] ?? `${repoRoot}infra/fly/proof.json`);
    await operateProof(process.argv[2], configPath, {
      run: (args, options) => run(flyctl, args, options),
      request: createAppRequest(run, flyctl),
      deploy: (path) =>
        run(
          process.execPath,
          ["infra/fly/deploy.mjs", "all", "--environment", path, ...process.argv.slice(4)],
          { stdio: "inherit" },
        ),
      secretRoot: resolve(repoRoot, ".tmp/fly-proof"),
    });
    console.log(`Proof ${process.argv[2]} completed. Secrets remain local and are never printed.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
