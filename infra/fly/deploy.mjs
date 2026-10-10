#!/usr/bin/env node
// Deploys one commit to the hosted Fly apps: builds their images, tags them with the commit SHA,
// pushes them to each app's Fly registry, then creates or updates each Machine from
// infra/fly/<app>/machine.json through the Machines API, with its full config. A deploy never
// starts a Machine.
//
// - The core is updated only while it sleeps, under its Machine lease: the script waits for an
//   awake core to sleep, or stops it with --force. A held lease fails the script, to be re-run.
//   A core whose host has no room for the new config is marked for recreation instead: the next
//   wake recreates it fresh and empty, at the new version, through the recovery path.
// - The runner is updated only while stopped, under its Machine lease, and left untouched when it
//   already has the config to deploy. A runner whose host has no room for the new config is
//   recreated on another host, then the old one destroyed.
// - `all` deploys the runner, the core and the gate, the first two under the core lease, so a
//   wake meanwhile shows the gate's updating page.
// - A core deploy writes the runner's config into the core, which recreates the runner from it,
//   and writes the core config it sent into the gate Machine, which recreates the core from it
//   (core recovery); a gate deploy carries that file over. A gate deploy also creates or updates
//   the guard, a scheduled Machine of the gate app that runs the gate image from
//   infra/fly/gate/guard-machine.json. A guard whose host has no room for the new config is
//   destroyed, then recreated.
// - The script ends by comparing the core's and the runner's versions (version handshake).
//
// Usage, from anywhere:
//   node infra/fly/deploy.mjs <all|core|runner|gate> [--force] [--fresh-core] [--no-depot | --local-build]
//   --force        stop an awake core or a running runner instead of waiting or refusing: the
//                  session ends, and a run in progress fails
//   --fresh-core   for incompatible changes: mark the core so that the next visitor wake recreates
//                  it fresh and empty, through the core recovery path
//   default        Fly remote builder (Depot)
//   --no-depot     Fly's previous remote builder, for a Depot incident
//   --local-build  local `docker build` plus `docker push`
// Environment: FLYCTL (flyctl executable, default "flyctl"). The Machines API calls use the
// token printed by `flyctl auth token`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isCapacityRefusal } from "./capacity-refusal.mjs";

const region = "cdg";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// biome-ignore lint/suspicious/noUndeclaredEnvVars: operator script, not a Turborepo task.
const flyctl = process.env.FLYCTL || "flyctl";
const builder = process.argv.includes("--local-build")
  ? "local"
  : process.argv.includes("--no-depot")
    ? "no-depot"
    : "depot";
const force = process.argv.includes("--force");
const freshCore = process.argv.includes("--fresh-core");
// Covers the work under the core lease at Fly's 60 s wait cap, retries included: a forced stop,
// the runner deploy, the core update and the gate update. A deploy killed meanwhile leaves the
// gate showing "updating" until it expires, or until `flyctl machine leases clear`.
const coreLeaseTtlSeconds = 600;
// Covers a forced stop and the update, each with its wait at Fly's 60 s cap, plus the full
// `MANIFEST_UNKNOWN` retry budget; the same TTL as the API's runner lease.
const runnerLeaseTtlSeconds = 300;
const sleepPollMs = 15_000;
const unknownImageRetries = 5;
const unknownImageRetryMs = 10_000;

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
    images: {
      gate: { dockerfile: "docker/Dockerfile.node-service", target: "runtime", service: "gate" },
    },
  },
};

const roles = process.argv[2] === "all" ? ["runner", "core", "gate"] : [process.argv[2]];
if (!targets[roles[0]] || (freshCore && !roles.includes("core"))) {
  console.error(
    "Usage: node infra/fly/deploy.mjs <all|core|runner|gate> [--force] [--fresh-core] [--no-depot | --local-build]\n" +
      "--fresh-core needs a deploy that includes the core.",
  );
  process.exit(64);
}

function readRepoJson(path) {
  return JSON.parse(readFileSync(`${repoRoot}${path}`, "utf8"));
}

// Fly returns no full config for a Machine on a host that is down, so the gate keeps a copy of the
// core's config, and the core a copy of the runner's.
const coreConfigGuestPath = readRepoJson("infra/fly/gate/machine.json").env
  .CORE_MACHINE_CONFIG_FILE;
const runnerConfigGuestPath = apiContainer(readRepoJson("infra/fly/core/machine.json")).env
  .RUNNER_MACHINE_CONFIG_FILE;

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

function buildAndPushRemotely(role, image, label) {
  run(
    flyctl,
    [
      "deploy",
      "-a",
      targets[role].app,
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

function buildAndPushImages(role, version) {
  const refs = {};
  // Uncommitted trees share one version, and Fly keeps a Machine's image when the reference is
  // unchanged, so each dirty build gets its own label.
  const buildStamp = version.endsWith("-dirty")
    ? `-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`
    : "";
  for (const [name, image] of Object.entries(targets[role].images)) {
    const label = `${name}-${version}${buildStamp}`;
    refs[name] = `registry.fly.io/${targets[role].app}:${label}`;
    console.log(`Building ${refs[name]} (${builder} builder)`);
    if (builder === "local") buildAndPushLocally(image, refs[name]);
    else buildAndPushRemotely(role, image, label);
  }
  return refs;
}

function machineConfig(role, imageRefs, file = "machine.json") {
  const config = readRepoJson(`infra/fly/${role}/${file}`);
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

function apiContainer(coreConfig) {
  return coreConfig.containers.find((container) => container.name === "api");
}

function jsonFile(guestPath, value) {
  return {
    guest_path: guestPath,
    raw_value: Buffer.from(JSON.stringify(value)).toString("base64"),
  };
}

function createMachinesApi(app) {
  return async (method, path, body, nonce) => {
    // Read per call: a token read before the builds was refused (403) once they had finished.
    const token = run(flyctl, ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
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

function waitForStopped(machinesApi, machineId) {
  return machinesApi("GET", `/machines/${machineId}/wait?state=stopped&timeout=60`);
}

/**
 * Runs `operation` on the Machine read again under its lease, so that nothing changed it since
 * the builds. A held lease (a wake, a recovery, the guard or a runner operation) fails the deploy.
 */
async function withLease(machinesApi, machineId, ttlSeconds, operation) {
  let nonce;
  try {
    const lease = await machinesApi("POST", `/machines/${machineId}/lease`, {
      ttl: ttlSeconds,
      description: "deploy",
    });
    nonce = lease.data.nonce;
  } catch (error) {
    if (error.status !== 409) throw error;
    throw new Error(`The lease of Machine ${machineId} is held; re-run the deploy.`);
  }
  try {
    return await operation(await machinesApi("GET", `/machines/${machineId}`), nonce);
  } finally {
    await machinesApi("DELETE", `/machines/${machineId}/lease`, undefined, nonce).catch((error) => {
      if (error.status !== 404) console.error(`Could not release the lease: ${error.message}`);
    });
  }
}

/** Stops a running Machine under its lease with --force; refuses it otherwise. */
async function requireStopped(machinesApi, machine, nonce) {
  if (machine.state === "stopped" || machine.state === "created") return;
  const role = machine.config.metadata.role;
  if (!force) {
    throw new Error(`${role} Machine ${machine.id} is ${machine.state}; re-run, or use --force.`);
  }
  console.log(`Stopping ${role} Machine ${machine.id} (--force).`);
  if (machine.state !== "stopping") {
    await machinesApi("POST", `/machines/${machine.id}/stop`, {}, nonce);
  }
  await waitForStopped(machinesApi, machine.id);
}

async function waitForCoreToSleep(machinesApi, machineId) {
  for (let announced = false; ; announced = true) {
    const { state } = await machinesApi("GET", `/machines/${machineId}`);
    if (state === "stopped" || state === "created") return;
    if (!announced) {
      console.log(
        `core Machine ${machineId} is ${state}; waiting for it to sleep (--force stops it).`,
      );
    }
    await sleep(sleepPollMs);
  }
}

/**
 * The Machines API can refuse an image pushed seconds before as unknown (`MANIFEST_UNKNOWN`,
 * observed after remote builds, while the registry already listed it), so that refusal is retried.
 */
async function sendConfig(send) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= unknownImageRetries || !error.message.includes("MANIFEST_UNKNOWN"))
        throw error;
      console.log("The Machines API does not see the new image yet; retrying.");
      await sleep(unknownImageRetryMs);
    }
  }
}

async function updateMachine(machinesApi, machineId, config, nonce) {
  await sendConfig(() =>
    machinesApi("POST", `/machines/${machineId}`, { region, config, skip_launch: true }, nonce),
  );
  // Fly refuses to start the Machine until it has finished preparing its new configuration.
  await waitForStopped(machinesApi, machineId);
}

/**
 * Whether `current` holds every value of `target`. Keys that Fly or the API add, such as the
 * runner's `API_BASE_URL`, are ignored: a key removed from a config file comes with a new commit,
 * so with a new image label and `COMMIT_SHA`.
 */
function includesConfig(current, target) {
  if (target === null || typeof target !== "object") return current === target;
  if (current === null || typeof current !== "object") return false;
  if (Array.isArray(target) && current.length !== target.length) return false;
  return Object.keys(target).every((key) => includesConfig(current[key], target[key]));
}

/** `placement` may be a prioritized list of regions, such as `cdg,eu`, which Fly tries in order. */
async function createMachine(machinesApi, role, config, placement = region) {
  const { volume } = targets[role];
  if (volume) {
    const created = await machinesApi("POST", "/volumes", {
      name: volume.name,
      region,
      size_gb: volume.sizeGb,
      compute: config.guest,
    });
    config.mounts[0].volume = created.id;
  }
  let machine;
  try {
    machine = await sendConfig(() =>
      machinesApi("POST", "/machines", { region: placement, config, skip_launch: true }),
    );
  } catch (error) {
    if (volume) await machinesApi("DELETE", `/volumes/${config.mounts[0].volume}`);
    throw error;
  }
  try {
    await waitForStopped(machinesApi, machine.id);
  } catch (error) {
    // A replacement that failed must not leave two Machines of one role behind.
    await machinesApi("DELETE", `/machines/${machine.id}?force=true`).catch((destroyError) => {
      console.error(`Could not destroy Machine ${machine.id}: ${destroyError.message}`);
    });
    throw error;
  }
}

async function deployRunner(imageRefs, version) {
  const machinesApi = createMachinesApi(targets.runner.app);
  const config = machineConfig("runner", imageRefs);
  // The API and the runner compare these versions before every run (version handshake).
  config.env.COMMIT_SHA = version;
  const existing = await findMachine(machinesApi, "runner");
  if (!existing) {
    await createMachine(machinesApi, "runner", config);
  } else {
    const unchanged = await withLease(
      machinesApi,
      existing.id,
      runnerLeaseTtlSeconds,
      async (machine, nonce) => {
        // A deploy of the same commit leaves the runner untouched, even during a run.
        if (includesConfig(machine.config, config)) return true;
        await requireStopped(machinesApi, machine, nonce);
        if (!(await updateInPlace(machinesApi, machine.id, config, nonce))) {
          await relocateRunner(machinesApi, machine.id, config, nonce);
        }
        return false;
      },
    );
    if (unchanged) {
      console.log(`runner Machine already has the config of version ${version}; left untouched.`);
      return;
    }
  }
  console.log(`runner Machine is stopped and ready to start at version ${version}.`);
}

/**
 * Every image of a config: each container's for a multi-container Machine (Fly also reports a
 * top-level image for it), else the Machine's own.
 */
function configImages(config) {
  return JSON.stringify(config.containers?.map((container) => container.image) ?? [config.image]);
}

/**
 * Updates a stopped Machine in place. False when its host has no room for the new config: Fly
 * refuses the update, or accepts it, then reverts it (observed on a full host).
 */
async function updateInPlace(machinesApi, machineId, config, nonce) {
  const { role } = config.metadata;
  try {
    await updateMachine(machinesApi, machineId, config, nonce);
  } catch (error) {
    if (!isCapacityRefusal(error)) throw error;
    console.log(`The ${role}'s host refused the update: ${error.message}`);
    return false;
  }
  const current = await machinesApi("GET", `/machines/${machineId}`);
  const [latest] = current.events ?? [];
  if (latest?.type !== "revert" && configImages(current.config) === configImages(config)) {
    return true;
  }
  console.log(
    `The ${role}'s host reverted the update: images ${configImages(current.config)}, expected ${configImages(config)}.`,
  );
  return false;
}

/**
 * Like the API's runner recreation (HD-17): a new runner from the new config, placed by Fly on a
 * host with room in the home region or else elsewhere in Europe, then the old one destroyed under
 * its lease. A failed create keeps the old runner.
 */
async function relocateRunner(machinesApi, oldMachineId, config, nonce) {
  console.log(`Recreating the runner on another host (${region}, then eu).`);
  await createMachine(machinesApi, "runner", config, `${region},eu`);
  await machinesApi("DELETE", `/machines/${oldMachineId}?force=true`, undefined, nonce);
  console.log(`Destroyed the old runner Machine ${oldMachineId}.`);
}

/** The runner's full config, as deployed, for the API to recreate the runner from. */
async function runnerConfigFile() {
  const runner = await findMachine(createMachinesApi(targets.runner.app), "runner");
  if (!runner?.config?.image) {
    throw new Error("No runner Machine with a full config; deploy the runner first.");
  }
  return jsonFile(runnerConfigGuestPath, runner.config);
}

/**
 * Updates the sleeping core under its lease, after `beforeUpdate` (the runner deploy in `all`),
 * then writes the core config into the gate before releasing the lease.
 */
async function deployCore(imageRefs, version, beforeUpdate) {
  const machinesApi = createMachinesApi(targets.core.app);
  const config = machineConfig("core", imageRefs);
  const api = apiContainer(config);
  api.env.COMMIT_SHA = version;
  const apply = async (machine, nonce) => {
    await beforeUpdate();
    api.files = [...(api.files ?? []), await runnerConfigFile()];
    if (!machine) {
      await createMachine(machinesApi, "core", config);
    } else {
      // A requested fresh core stays requested until a wake acts on it, with the reason it was
      // marked for: the core must never start on data its new version cannot use.
      const { recreate, recreate_reason: reason } = machine.config.metadata ?? {};
      if (freshCore || recreate === "requested") config.metadata.recreate = "requested";
      if (recreate === "requested" && reason) config.metadata.recreate_reason = reason;
      config.mounts[0].volume = machine.config.mounts[0].volume;
      if (!(await updateInPlace(machinesApi, machine.id, config, nonce))) {
        await markCoreForRecreation(machinesApi, machine.id, nonce);
        Object.assign(config.metadata, capacityRecreationMark);
      }
    }
    console.log(`core Machine is stopped and ready to start at version ${version}.`);
    if (config.metadata.recreate === "requested") {
      console.log("The next wake recreates the core fresh and empty, through the recovery path.");
    }
    await writeCoreConfigToGate(config);
  };
  const existing = await findMachine(machinesApi, "core");
  if (!existing) return apply(undefined, undefined);
  if (!force) await waitForCoreToSleep(machinesApi, existing.id);
  await withLease(machinesApi, existing.id, coreLeaseTtlSeconds, async (machine, nonce) => {
    await requireStopped(machinesApi, machine, nonce);
    await apply(machine, nonce);
  });
}

// The reason makes the gate show its relocating page rather than the fresh-install page an
// operator's mark gets. It is set first, so the mark never stands without it; a failed second
// write leaves an inert reason, which the gate ignores and the next deploy drops.
const capacityRecreationMark = { recreate_reason: "capacity", recreate: "requested" };

/**
 * Sets the recreation mark (HD-35) on a core whose host has no room for the new config: its volume
 * pins it there. The next wake recreates it elsewhere from the config this deploy writes into the
 * gate, so at the new version, fresh and empty.
 */
async function markCoreForRecreation(machinesApi, machineId, nonce) {
  for (const [key, value] of Object.entries(capacityRecreationMark)) {
    await machinesApi("POST", `/machines/${machineId}/metadata/${key}`, { value }, nonce);
  }
  console.log(
    `Marked core Machine ${machineId} for recreation; it keeps its old config until then.`,
  );
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
  const { volume } = targets.core;
  const recoveryConfig = {
    ...coreConfig,
    mounts: [{ ...coreConfig.mounts[0], name: volume.name, size_gb: volume.sizeGb }],
  };
  await updateMachine(
    gateApi,
    gate.id,
    withGateFile(gate.config, jsonFile(coreConfigGuestPath, recoveryConfig)),
  );
  console.log(`gate Machine ${gate.id} now holds the core config for recovery.`);
}

/**
 * The gate is stateless, so it is updated in any state; Fly Proxy starts it again on the next
 * request. It is read only now, so it carries over the core config a core deploy just wrote.
 */
async function deployGate(imageRefs, version) {
  const machinesApi = createMachinesApi(targets.gate.app);
  const config = machineConfig("gate", imageRefs);
  // Identifies the gate's deployment only; the handshake does not compare it.
  config.env.COMMIT_SHA = version;
  const existing = await findMachine(machinesApi, "gate");
  const coreConfigFile = existing?.config.files?.find(
    (file) => file.guest_path === coreConfigGuestPath,
  );
  if (coreConfigFile) config.files = [...(config.files ?? []), coreConfigFile];
  if (existing) await updateMachine(machinesApi, existing.id, config);
  else await createMachine(machinesApi, "gate", config);
  console.log(`gate Machine is stopped and ready to start at version ${version}.`);
  await deployGuard(machinesApi, imageRefs, version);
}

/**
 * The guard runs the gate image on its schedule; like the gate, it is updated in any state. It is
 * sent without `skip_launch`, which keeps Fly's scheduler from ever starting it (observed): a
 * create runs it once, and an update leaves a stopped guard stopped.
 */
async function deployGuard(machinesApi, imageRefs, version) {
  const config = machineConfig("gate", imageRefs, "guard-machine.json");
  config.env.COMMIT_SHA = version;
  const existing = await findMachine(machinesApi, "guard");
  const machine = existing
    ? await updateOrRelocateGuard(machinesApi, existing.id, config)
    : await sendGuardConfig(machinesApi, config);
  // No wait for `stopped`: a created guard runs its first pass, which can outlast Fly's wait.
  console.log(`guard Machine ${machine.id} is scheduled ${config.schedule} at version ${version}.`);
}

/** Creates a guard from `config`, or updates the guard `machineId` to it. */
function sendGuardConfig(machinesApi, config, machineId) {
  return sendConfig(() =>
    machinesApi("POST", `/machines${machineId ? `/${machineId}` : ""}`, { region, config }),
  );
}

/**
 * A guard whose host refuses the new config is replaced, since it is stateless (HD-62): the old
 * one destroyed first, so two guards never coexist, then a new one created. A failed destroy keeps
 * the old guard; a failed create leaves none, and the deploy fails so that a re-run creates it.
 */
async function updateOrRelocateGuard(machinesApi, machineId, config) {
  try {
    return await sendGuardConfig(machinesApi, config, machineId);
  } catch (error) {
    if (!isCapacityRefusal(error)) throw error;
    console.log(`The guard's host refused the update: ${error.message}`);
  }
  // Forced: a guard in the middle of its pass is stopped; its leases expire on their own.
  await machinesApi("DELETE", `/machines/${machineId}?force=true`);
  let machine;
  try {
    machine = await sendGuardConfig(machinesApi, config);
  } catch (error) {
    throw new Error(
      `Destroyed guard Machine ${machineId}, but creating its replacement failed: ${error.message}; re-run the deploy, which creates the guard.`,
    );
  }
  console.log(
    `Relocated the guard: destroyed guard Machine ${machineId}, then created guard Machine ${machine.id} on a host with room.`,
  );
  return machine;
}

/**
 * The version the core runs at its next wake: a core marked for recreation never starts again, and
 * the wake recreates it from the core config in the gate.
 */
async function nextCoreVersion(core) {
  if (core.config.metadata?.recreate !== "requested") {
    return apiContainer(core.config)?.env?.COMMIT_SHA;
  }
  const gate = await findMachine(createMachinesApi(targets.gate.app), "gate");
  const file = gate?.config.files?.find((kept) => kept.guest_path === coreConfigGuestPath);
  if (!file) return undefined;
  const recoveryConfig = JSON.parse(Buffer.from(file.raw_value, "base64").toString("utf8"));
  console.log(
    "The core is marked for recreation: its version is the one the gate recreates it at.",
  );
  return apiContainer(recoveryConfig)?.env?.COMMIT_SHA;
}

/** Reports a partial deployment, which the version handshake makes refuse every run. */
async function verifyVersions() {
  const core = await findMachine(createMachinesApi(targets.core.app), "core");
  const runner = await findMachine(createMachinesApi(targets.runner.app), "runner");
  const coreVersion = core && (await nextCoreVersion(core));
  const runnerVersion = runner?.config.env?.COMMIT_SHA;
  if (coreVersion && coreVersion === runnerVersion) {
    console.log(`The core and the runner both run version ${coreVersion}.`);
    return;
  }
  console.error(
    `Partial deployment: the core runs version ${coreVersion} and the runner ${runnerVersion}. ` +
      "Runs are refused until both are deployed from one commit.",
  );
  process.exitCode = 1;
}

async function deploy() {
  const version = commitVersion();
  // Fails before the builds on two Machines of one role (a recovery in progress, or its leftover).
  for (const role of roles) await findMachine(createMachinesApi(targets[role].app), role);
  if (builder === "local") run(flyctl, ["auth", "docker"], { stdio: "inherit" });
  const imageRefs = Object.fromEntries(
    roles.map((role) => [role, buildAndPushImages(role, version)]),
  );
  if (roles.includes("core")) {
    await deployCore(imageRefs.core, version, async () => {
      if (roles.includes("runner")) await deployRunner(imageRefs.runner, version);
    });
  } else if (roles.includes("runner")) {
    await deployRunner(imageRefs.runner, version);
  }
  if (roles.includes("gate")) await deployGate(imageRefs.gate, version);
}

function fail(error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

// A failed step can leave a partial deployment, so the versions are compared in every case.
await deploy().catch(fail);
await verifyVersions().catch(fail);
