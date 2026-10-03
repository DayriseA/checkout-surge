#!/usr/bin/env node
// Deploys one hosted Fly app: builds its images, tags them with the commit SHA, pushes them to
// the app's Fly registry, then creates or updates its stopped Machine from
// infra/fly/<target>/machine.json through the Machines API. The Machine is never started here.
//
// Usage, from anywhere: node infra/fly/deploy.mjs <core|runner> [--no-depot | --local-build]
//   default        Fly remote builder (Depot)
//   --no-depot     Fly's previous remote builder, for a Depot incident
//   --local-build  local `docker build` plus `docker push`
// Environment: FLYCTL (flyctl executable, default "flyctl"). The Machines API calls use the
// token printed by `flyctl auth token`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const region = "cdg";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// biome-ignore lint/suspicious/noUndeclaredEnvVars: operator script, not a Turborepo task.
const flyctl = process.env.FLYCTL || "flyctl";
const builder = process.argv.includes("--local-build")
  ? "local"
  : process.argv.includes("--no-depot")
    ? "no-depot"
    : "depot";

// Image fields in machine.json hold an image name from `images`; the script replaces them.
const targets = {
  core: {
    app: "checkout-surge-core",
    volume: { name: "core_data", sizeGb: 3 },
    images: {
      api: { dockerfile: "docker/Dockerfile.node-service", target: "runtime-fly", service: "api" },
      worker: {
        dockerfile: "docker/Dockerfile.node-service",
        target: "runtime",
        service: "worker",
      },
      "mock-erp": {
        dockerfile: "docker/Dockerfile.node-service",
        target: "runtime",
        service: "mock-erp",
      },
      web: { dockerfile: "apps/web/Dockerfile", target: "runtime" },
      setup: { dockerfile: "packages/db/Dockerfile", target: "runtime" },
    },
  },
  runner: {
    app: "checkout-surge-runner",
    images: {
      "load-orchestrator": {
        dockerfile: "apps/load-orchestrator/Dockerfile",
        target: "runtime-fly",
      },
    },
  },
};

const role = process.argv[2];
const target = targets[role];
if (!target) {
  console.error("Usage: node infra/fly/deploy.mjs <core|runner> [--no-depot | --local-build]");
  process.exit(64);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
}

function commitVersion() {
  const sha = run("git", ["rev-parse", "HEAD"]).trim();
  const dirty = run("git", ["status", "--porcelain"]).trim() !== "";
  return dirty ? `${sha}-dirty` : sha;
}

function buildArgs(image) {
  return image.service ? ["--build-arg", `SERVICE_NAME=${image.service}`] : [];
}

function buildAndPushRemotely(image, label) {
  run(
    flyctl,
    [
      "deploy",
      "-a",
      target.app,
      "-c",
      `infra/fly/${role}/build.toml`,
      "--build-only",
      "--push",
      "--remote-only",
      `--depot=${builder === "depot"}`,
      "--image-label",
      label,
      "--dockerfile",
      image.dockerfile,
      "--build-target",
      image.target,
      ...buildArgs(image),
    ],
    { stdio: "inherit" },
  );
}

function buildAndPushLocally(image, ref) {
  run(
    "docker",
    [
      "build",
      "--platform",
      "linux/amd64",
      "-f",
      image.dockerfile,
      "--target",
      image.target,
      ...buildArgs(image),
      "-t",
      ref,
      ".",
    ],
    { stdio: "inherit" },
  );
  run("docker", ["push", ref], { stdio: "inherit" });
}

function buildAndPushImages(version) {
  if (builder === "local") run(flyctl, ["auth", "docker"], { stdio: "inherit" });
  const refs = {};
  for (const [name, image] of Object.entries(target.images)) {
    const label = `${name}-${version}`;
    refs[name] = `registry.fly.io/${target.app}:${label}`;
    console.log(`Building ${refs[name]} (${builder} builder)`);
    if (builder === "local") buildAndPushLocally(image, refs[name]);
    else buildAndPushRemotely(image, label);
  }
  return refs;
}

function machineConfig(imageRefs) {
  const config = JSON.parse(readFileSync(`${repoRoot}infra/fly/${role}/machine.json`, "utf8"));
  // A multi-container Machine (core) sets images per container; a single-image one (runner) at the top.
  for (const holder of [config, ...(config.containers ?? [])]) {
    if (holder.image in imageRefs) holder.image = imageRefs[holder.image];
    for (const file of holder.files ?? []) {
      if (!file.local_path) continue;
      file.raw_value = readFileSync(`${repoRoot}${file.local_path}`).toString("base64");
      delete file.local_path;
    }
  }
  return config;
}

function createMachinesApi() {
  return async (method, path, body) => {
    // Read per call: a token read before the builds was refused (403) once they had finished.
    const token = run(flyctl, ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
    const response = await fetch(`https://api.machines.dev/v1/apps/${target.app}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
}

async function findMachine(machinesApi) {
  const machines = await machinesApi("GET", "/machines");
  const matches = machines.filter((machine) => machine.config?.metadata?.role === role);
  if (matches.length > 1) {
    throw new Error(`Expected at most one ${role} Machine, found ${matches.length}.`);
  }
  return matches[0];
}

async function createMachine(machinesApi, config) {
  if (!target.volume) {
    return machinesApi("POST", "/machines", { region, config, skip_launch: true });
  }
  const volume = await machinesApi("POST", "/volumes", {
    name: target.volume.name,
    region,
    size_gb: target.volume.sizeGb,
    compute: config.guest,
  });
  config.mounts[0].volume = volume.id;
  try {
    return await machinesApi("POST", "/machines", { region, config, skip_launch: true });
  } catch (error) {
    await machinesApi("DELETE", `/volumes/${volume.id}`);
    throw error;
  }
}

async function updateMachine(machinesApi, machine, config) {
  if (target.volume) config.mounts[0].volume = machine.config.mounts[0].volume;
  return machinesApi("POST", `/machines/${machine.id}`, { region, config, skip_launch: true });
}

async function main() {
  const version = commitVersion();
  const machinesApi = createMachinesApi();
  const existing = await findMachine(machinesApi);
  if (existing && existing.state !== "stopped" && existing.state !== "created") {
    throw new Error(
      `${role} Machine ${existing.id} is ${existing.state}; stop it before deploying.`,
    );
  }

  const config = machineConfig(buildAndPushImages(version));
  // The API and the runner compare these versions before every run (version handshake).
  const versioned =
    role === "runner" ? config : config.containers.find((container) => container.name === "api");
  versioned.env.COMMIT_SHA = version;
  const machine = existing
    ? await updateMachine(machinesApi, existing, config)
    : await createMachine(machinesApi, config);
  // Fly refuses to start the Machine until it has finished preparing its new configuration.
  await machinesApi("GET", `/machines/${machine.id}/wait?state=stopped&timeout=60`);
  console.log(`${role} Machine ${machine.id} is stopped and ready to start at version ${version}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
