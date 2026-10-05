#!/usr/bin/env node
// Deploys one hosted Fly app: builds its images, tags them with the commit SHA, pushes them to
// the app's Fly registry, then creates or updates its stopped Machine from
// infra/fly/<target>/machine.json through the Machines API. The Machine is never started here.
//
// A core deploy also writes the core config it sent into the gate Machine, as a file the gate
// recreates the core from (core recovery); a gate deploy carries that file over. A gate deploy
// also creates or updates the guard, a scheduled Machine of the gate app that runs the gate image
// from infra/fly/gate/guard-machine.json.
//
// Usage, from anywhere: node infra/fly/deploy.mjs <core|runner|gate> [--no-depot | --local-build]
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
  gate: {
    app: "checkout-surge-gate",
    // Stateless: updated in any state. Fly Proxy starts it again on the next request.
    updatesRunning: true,
    images: {
      gate: { dockerfile: "docker/Dockerfile.node-service", target: "runtime", service: "gate" },
    },
  },
};

// Fly returns no full config for a Machine on a host that is down, so the gate keeps its own copy.
const coreConfigGuestPath = JSON.parse(
  readFileSync(`${repoRoot}infra/fly/gate/machine.json`, "utf8"),
).env.CORE_MACHINE_CONFIG_FILE;

const role = process.argv[2];
const target = targets[role];
if (!target) {
  console.error("Usage: node infra/fly/deploy.mjs <core|runner|gate> [--no-depot | --local-build]");
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
  // Uncommitted trees share one version, and Fly keeps a Machine's image when the reference is
  // unchanged, so each dirty build gets its own label.
  const buildStamp = version.endsWith("-dirty")
    ? `-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`
    : "";
  for (const [name, image] of Object.entries(target.images)) {
    const label = `${name}-${version}${buildStamp}`;
    refs[name] = `registry.fly.io/${target.app}:${label}`;
    console.log(`Building ${refs[name]} (${builder} builder)`);
    if (builder === "local") buildAndPushLocally(image, refs[name]);
    else buildAndPushRemotely(image, label);
  }
  return refs;
}

function machineConfig(imageRefs, file = "machine.json") {
  const config = JSON.parse(readFileSync(`${repoRoot}infra/fly/${role}/${file}`, "utf8"));
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

function createMachinesApi(app) {
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

async function findMachine(machinesApi, machineRole) {
  const machines = await machinesApi("GET", "/machines");
  const matches = machines.filter((machine) => machine.config?.metadata?.role === machineRole);
  if (matches.length > 1) {
    throw new Error(`Expected at most one ${machineRole} Machine, found ${matches.length}.`);
  }
  return matches[0];
}

/** The gate config with `file` replacing any file at the same guest path. */
function withGateFile(config, file) {
  const files = (config.files ?? []).filter((kept) => kept.guest_path !== file.guest_path);
  return { ...config, files: [...files, file] };
}

/**
 * Writes the core config just sent, with its volume's name and size, into the gate Machine
 * through a full-config update. The gate is stateless, so it is updated in any state.
 */
async function writeCoreConfigToGate(coreConfig) {
  const gateApi = createMachinesApi(targets.gate.app);
  const gate = await findMachine(gateApi, "gate");
  if (!gate) throw new Error("Deploy the gate first: the core config is written into it.");
  const recoveryConfig = {
    ...coreConfig,
    mounts: [{ ...coreConfig.mounts[0], name: target.volume.name, size_gb: target.volume.sizeGb }],
  };
  const file = {
    guest_path: coreConfigGuestPath,
    raw_value: Buffer.from(JSON.stringify(recoveryConfig)).toString("base64"),
  };
  const updated = await gateApi("POST", `/machines/${gate.id}`, {
    config: withGateFile(gate.config, file),
    skip_launch: true,
  });
  await gateApi("GET", `/machines/${updated.id}/wait?state=stopped&timeout=60`);
  console.log(`gate Machine ${gate.id} now holds the core config for recovery.`);
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

/**
 * The guard runs the gate image on its schedule; like the gate, it is updated in any state. It is
 * sent without `skip_launch`, which keeps Fly's scheduler from ever starting it (observed): a
 * create runs it once, and an update leaves a stopped guard stopped.
 */
async function deployGuard(machinesApi, imageRefs, version) {
  const config = machineConfig(imageRefs, "guard-machine.json");
  config.env.COMMIT_SHA = version;
  const existing = await findMachine(machinesApi, "guard");
  const machine = await machinesApi("POST", `/machines${existing ? `/${existing.id}` : ""}`, {
    region,
    config,
  });
  // No wait for `stopped`: a created guard runs its first pass, which can outlast Fly's wait.
  console.log(`guard Machine ${machine.id} is scheduled ${config.schedule} at version ${version}.`);
}

async function main() {
  const version = commitVersion();
  const machinesApi = createMachinesApi(target.app);
  const existing = await findMachine(machinesApi, role);
  if (
    existing &&
    !target.updatesRunning &&
    existing.state !== "stopped" &&
    existing.state !== "created"
  ) {
    throw new Error(
      `${role} Machine ${existing.id} is ${existing.state}; stop it before deploying.`,
    );
  }

  const imageRefs = buildAndPushImages(version);
  const config = machineConfig(imageRefs);
  // The API and the runner compare these versions before every run (version handshake). The
  // gate's only identifies its deployment.
  const versioned =
    role === "core" ? config.containers.find((container) => container.name === "api") : config;
  versioned.env.COMMIT_SHA = version;
  if (role === "gate") {
    const coreConfigFile = existing?.config.files?.find(
      (file) => file.guest_path === coreConfigGuestPath,
    );
    if (coreConfigFile) config.files = [...(config.files ?? []), coreConfigFile];
  }
  const machine = existing
    ? await updateMachine(machinesApi, existing, config)
    : await createMachine(machinesApi, config);
  // Fly refuses to start the Machine until it has finished preparing its new configuration.
  await machinesApi("GET", `/machines/${machine.id}/wait?state=stopped&timeout=60`);
  console.log(`${role} Machine ${machine.id} is stopped and ready to start at version ${version}.`);
  if (role === "core") await writeCoreConfigToGate(config);
  if (role === "gate") await deployGuard(machinesApi, imageRefs, version);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
