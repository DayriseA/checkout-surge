#!/usr/bin/env node
// Deploys the hosted core: builds the core service images, tags them with the commit SHA,
// pushes them to the Fly registry, then creates or updates the stopped core Machine from
// infra/fly/core/machine.json through the Machines API. The Machine is never started here.
//
// Usage, from anywhere: node infra/fly/core/deploy.mjs [--no-depot | --local-build]
//   default        Fly remote builder (Depot)
//   --no-depot     Fly's previous remote builder, for a Depot incident
//   --local-build  local `docker build` plus `docker push`
// Environment: FLYCTL (flyctl executable, default "flyctl"). The Machines API calls use the
// token printed by `flyctl auth token`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = "checkout-surge-core";
const region = "cdg";
const volumeName = "core_data";
const volumeSizeGb = 3;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
// biome-ignore lint/suspicious/noUndeclaredEnvVars: operator script, not a Turborepo task.
const flyctl = process.env.FLYCTL || "flyctl";
const builder = process.argv.includes("--local-build")
  ? "local"
  : process.argv.includes("--no-depot")
    ? "no-depot"
    : "depot";

const images = {
  api: { dockerfile: "docker/Dockerfile.node-service", target: "runtime-fly", service: "api" },
  worker: { dockerfile: "docker/Dockerfile.node-service", target: "runtime", service: "worker" },
  "mock-erp": {
    dockerfile: "docker/Dockerfile.node-service",
    target: "runtime",
    service: "mock-erp",
  },
  web: { dockerfile: "apps/web/Dockerfile", target: "runtime" },
  setup: { dockerfile: "packages/db/Dockerfile", target: "runtime" },
};

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
      app,
      "-c",
      "infra/fly/core/build.toml",
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
  for (const [name, image] of Object.entries(images)) {
    const label = `${name}-${version}`;
    refs[name] = `registry.fly.io/${app}:${label}`;
    console.log(`Building ${refs[name]} (${builder} builder)`);
    if (builder === "local") buildAndPushLocally(image, refs[name]);
    else buildAndPushRemotely(image, label);
  }
  return refs;
}

function machineConfig(imageRefs) {
  const config = JSON.parse(readFileSync(`${repoRoot}infra/fly/core/machine.json`, "utf8"));
  for (const container of config.containers) {
    container.image = imageRefs[container.name] ?? container.image;
    for (const file of container.files ?? []) {
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
    const response = await fetch(`https://api.machines.dev/v1/apps/${app}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
}

async function findCoreMachine(machinesApi) {
  const machines = await machinesApi("GET", "/machines");
  const cores = machines.filter((machine) => machine.config?.metadata?.role === "core");
  if (cores.length > 1) {
    throw new Error(`Expected at most one core Machine, found ${cores.length}.`);
  }
  return cores[0];
}

async function createCore(machinesApi, config) {
  const volume = await machinesApi("POST", "/volumes", {
    name: volumeName,
    region,
    size_gb: volumeSizeGb,
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

async function updateCore(machinesApi, core, config) {
  config.mounts[0].volume = core.config.mounts[0].volume;
  return machinesApi("POST", `/machines/${core.id}`, { region, config, skip_launch: true });
}

async function main() {
  const version = commitVersion();
  const machinesApi = createMachinesApi();
  const existingCore = await findCoreMachine(machinesApi);
  if (existingCore && existingCore.state !== "stopped" && existingCore.state !== "created") {
    throw new Error(
      `Core Machine ${existingCore.id} is ${existingCore.state}; stop it before deploying.`,
    );
  }

  const config = machineConfig(buildAndPushImages(version));
  const core = existingCore
    ? await updateCore(machinesApi, existingCore, config)
    : await createCore(machinesApi, config);
  // Fly refuses to start the Machine until it has finished preparing its new configuration.
  await machinesApi("GET", `/machines/${core.id}/wait?state=stopped&timeout=60`);
  console.log(`Core Machine ${core.id} is stopped and ready to start at version ${version}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
