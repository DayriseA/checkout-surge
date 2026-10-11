import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAppRequest, production, verifyApps } from "../environment.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export function loadLab(path) {
  const lab = JSON.parse(readFileSync(path, "utf8"));
  const names = Object.values(lab.apps ?? {});
  if (
    lab.name !== "feasibility" ||
    lab.organization !== "playground-416" ||
    lab.region !== "cdg" ||
    Object.keys(lab.apps ?? {})
      .sort()
      .join(",") !== "core,runner,stores" ||
    new Set(names).size !== 3 ||
    names.some(
      (name) =>
        typeof name !== "string" ||
        !/^cs-feasibility-[a-z0-9-]+$/.test(name) ||
        Object.values(production.apps).includes(name),
    ) ||
    ![2, 3].includes(lab.apiCount) ||
    !Number.isInteger(lab.poolMax) ||
    lab.poolMax < 1 ||
    !Number.isFinite(lab.storeDelayMs) ||
    lab.storeDelayMs < 0 ||
    lab.storeDelayMs > 20
  ) {
    throw new Error(
      "Only an explicit three-app playground-416 feasibility configuration is allowed.",
    );
  }
  return lab;
}

export function machineConfigs(lab, images, volumeId) {
  const common = {
    FEASIBILITY_LAB: "true",
    LAB_POOL_MAX: String(lab.poolMax),
    LAB_API_COUNT: String(lab.apiCount),
    LOG_LEVEL: "warn",
  };
  const secret = (name) => ({ env_var: name });
  const apiTargets = Array.from({ length: lab.apiCount }, (_, n) => `127.0.0.1:${4001 + n}`).join(
    " ",
  );
  return {
    core: {
      guest: { cpu_kind: "performance", cpus: 6, memory_mb: 12288 },
      metadata: { role: "feasibility-core" },
      containers: [
        {
          name: "lab",
          image: images.core,
          env: common,
          cmd: ["node", "scripts/feasibility/core.mjs"],
          secrets: ["DATABASE_URL", "REDIS_URL", "LAB_TOKEN"].map(secret),
          restart: { policy: "on-failure" },
        },
        {
          name: "ingress",
          image: "caddy:2-alpine",
          restart: { policy: "on-failure" },
          files: [
            {
              guest_path: "/etc/caddy/Caddyfile",
              raw_value: Buffer.from(
                `:8080 {\n @buy path /buy\n reverse_proxy @buy ${apiTargets}\n reverse_proxy 127.0.0.1:4500\n}\n`,
              ).toString("base64"),
            },
          ],
        },
      ],
    },
    stores: {
      guest: { cpu_kind: "performance", cpus: 2, memory_mb: 4096 },
      metadata: { role: "feasibility-stores" },
      volumes: [{ name: "data" }],
      mounts: [{ name: "data", volume: volumeId, path: "/persistent" }],
      containers: [
        {
          name: "observer",
          image: images.stores,
          env: common,
          secrets: [secret("LAB_TOKEN")],
          cmd: [
            "sh",
            "-c",
            `tc qdisc replace dev eth0 root netem delay ${lab.storeDelayMs}ms && exec node scripts/feasibility/store-observer.mjs`,
          ],
          restart: { policy: "on-failure" },
        },
        {
          name: "postgres",
          image: "postgres:17-alpine",
          env: { POSTGRES_DB: "checkout_surge_proof", POSTGRES_USER: "postgres" },
          secrets: [secret("POSTGRES_PASSWORD")],
          cmd: [
            "sh",
            "-c",
            "sh /fly/sample-store.sh postgres & export PGDATA=/persistent/postgres; exec docker-entrypoint.sh postgres -c listen_addresses='*'",
          ],
          files: [
            {
              guest_path: "/fly/sample-store.sh",
              local_path: "infra/fly/feasibility/sample-store.sh",
            },
          ],
          restart: { policy: "on-failure" },
        },
        {
          name: "redis",
          image: "redis:7-alpine",
          secrets: [secret("REDIS_PASSWORD")],
          cmd: [
            "sh",
            "-c",
            "mkdir -p /persistent/redis; cd /persistent/redis; sh /fly/sample-store.sh redis & exec docker-entrypoint.sh redis-server --dir /persistent/redis --appendonly yes --bind '0.0.0.0' '::' --requirepass \"$REDIS_PASSWORD\"",
          ],
          files: [
            {
              guest_path: "/fly/sample-store.sh",
              local_path: "infra/fly/feasibility/sample-store.sh",
            },
          ],
          restart: { policy: "on-failure" },
        },
      ],
    },
    runner: {
      image: images.runner,
      guest: { cpu_kind: "performance", cpus: 16, memory_mb: 32768 },
      metadata: { role: "feasibility-runner" },
      env: {
        ...common,
        LAB_CORE_URL: `http://${lab.apps.core}.internal:8080`,
        LAB_STORES_URL: `http://${lab.apps.stores}.internal:4501`,
      },
      secrets: [secret("LAB_TOKEN")],
      init: { exec: ["/bin/sleep", "infinity"] },
      restart: { policy: "no" },
    },
  };
}

export async function operateLab(
  action,
  configPath,
  { run, request, secretRoot = resolve(root, ".tmp/feasibility") },
) {
  const lab = loadLab(configPath);
  if (!["create", "build", "deploy", "start", "stop", "destroy"].includes(action))
    throw new Error("Unknown lab lifecycle action.");
  const existing = await verifyApps(lab, request, ["create", "destroy"].includes(action));
  const dir = resolve(secretRoot, lab.apps.core);
  const path = (role) => resolve(dir, `${role}.env`);
  const mutate = async (command, args, options) => {
    await verifyApps(lab, request, true);
    return run(command, args, options);
  };
  const api = async (method, app, endpoint, body) => {
    await verifyApps(lab, request);
    return request(method, app, endpoint, body);
  };
  if (action === "destroy") {
    for (const app of existing) await mutate("flyctl", ["apps", "destroy", app, "--yes"]);
    if (!dir.startsWith(resolve(secretRoot) + sep))
      throw new Error("Lab cleanup escaped its secret directory.");
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    return;
  }
  if (action === "create") {
    const saved = ["core", "stores", "runner"].every((role) => existsSync(path(role)));
    if (existing.size && !saved)
      throw new Error("Existing lab without complete saved credentials; destroy it first.");
    if (!existing.size && saved)
      throw new Error("Stale lab credentials; destroy them through the lab command first.");
    for (const app of Object.values(lab.apps))
      if (!existing.has(app))
        await mutate("flyctl", ["apps", "create", app, "--org", lab.organization]);
    if (!saved) {
      const secret = () => randomBytes(32).toString("hex");
      const pg = secret();
      const redis = secret();
      const token = secret();
      const values = {
        stores: { POSTGRES_PASSWORD: pg, REDIS_PASSWORD: redis, LAB_TOKEN: token },
        core: {
          DATABASE_URL: `postgresql://postgres:${pg}@${lab.apps.stores}.internal:5432/checkout_surge_proof`,
          REDIS_URL: `redis://:${redis}@${lab.apps.stores}.internal:6379`,
          LAB_TOKEN: token,
        },
        runner: { LAB_TOKEN: token },
      };
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const [role, value] of Object.entries(values))
        writeFileSync(
          path(role),
          `${Object.entries(value)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")}\n`,
          { flag: "wx", mode: 0o600 },
        );
    }
    for (const [role, app] of Object.entries(lab.apps))
      await mutate("flyctl", ["secrets", "import", "--stage", "--app", app], {
        input: readFileSync(path(role), "utf8"),
      });
    return;
  }
  if (action === "build") {
    mkdirSync(dir, { recursive: true });
    const tag = `lab-${Date.now()}`;
    const images = {};
    for (const [role, app] of Object.entries(lab.apps)) {
      await mutate("flyctl", [
        "deploy",
        "--build-only",
        "--push",
        "--remote-only",
        "--app",
        app,
        "--config",
        "infra/fly/feasibility/build.toml",
        "--image-label",
        tag,
      ]);
      images[role] = `registry.fly.io/${app}:${tag}`;
    }
    writeFileSync(resolve(dir, "images.json"), JSON.stringify(images, null, 2));
    return;
  }
  if (action === "deploy") {
    const images = JSON.parse(readFileSync(resolve(dir, "images.json"), "utf8"));
    const machines = {};
    for (const [role, app] of Object.entries(lab.apps)) {
      machines[role] = await request("GET", app, "/machines");
      if (machines[role].some((machine) => machine.state !== "stopped"))
        throw new Error("Stop every lab Machine before deploying.");
      if (machines[role].length > 1) throw new Error("Expected at most one Machine per lab app.");
    }
    const volumes = await request("GET", lab.apps.stores, "/volumes");
    const volume =
      volumes[0] ??
      (await api("POST", lab.apps.stores, "/volumes", {
        name: "proof_stores",
        region: lab.region,
        size_gb: 6,
      }));
    const configs = machineConfigs(lab, images, volume.id);
    for (const [role, config] of Object.entries(configs)) {
      for (const container of config.containers ?? [])
        for (const file of container.files ?? []) {
          if (file.local_path) {
            file.raw_value = readFileSync(resolve(root, file.local_path)).toString("base64");
            delete file.local_path;
          }
        }
      const machine = machines[role][0];
      await api("POST", lab.apps[role], machine ? `/machines/${machine.id}` : "/machines", {
        name: `feasibility-${role}`,
        region: lab.region,
        config,
        skip_launch: true,
      });
    }
    return;
  }
  const roles = action === "start" ? ["stores", "core", "runner"] : ["runner", "core", "stores"];
  for (const role of roles) {
    const machines = await request("GET", lab.apps[role], "/machines");
    for (const machine of machines) {
      if (machine.state === (action === "start" ? "started" : "stopped")) continue;
      await api("POST", lab.apps[role], `/machines/${machine.id}/${action}`);
      for (let count = 0; count < 120; count++) {
        const state = await request("GET", lab.apps[role], `/machines/${machine.id}`);
        if (state.state === (action === "start" ? "started" : "stopped")) break;
        if (count === 119) throw new Error(`Machine ${action} timed out.`);
        await new Promise((done) => setTimeout(done, 500));
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: direct operator script, outside Turborepo caching.
  const flyctl = process.env.FLYCTL ?? "flyctl";
  const run = (command, args, options = {}) =>
    execFileSync(command === "flyctl" ? flyctl : command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  const request = createAppRequest(run, flyctl);
  await operateLab(process.argv[2], resolve(process.argv[3] ?? "infra/fly/feasibility/lab.json"), {
    run,
    request,
  });
  console.log(`Lab ${process.argv[2]} completed.`);
}
