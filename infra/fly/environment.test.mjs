import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureMachine, loadEnvironment, production, verifyApps } from "./environment.mjs";
import { operateProof } from "./proof.mjs";

const proofPath = new URL("./proof.json", import.meta.url);
const proof = loadEnvironment(proofPath);

function fixture(t, configuration = proof) {
  const directory = mkdtempSync(join(tmpdir(), "fly-proof-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify(configuration));
  const apps = new Map();
  const mutations = [];
  const reads = [];
  const request = async (method, app) => {
    assert.equal(method, "GET");
    reads.push(app);
    if (!apps.has(app)) throw Object.assign(new Error("Not found"), { status: 404 });
    return { organization: { slug: apps.get(app) } };
  };
  const run = (args, options) => {
    mutations.push({ args, input: options?.input });
    if (args[0] === "apps" && args[1] === "create") apps.set(args[2], proof.organization);
    if (args[0] === "apps" && args[1] === "destroy") apps.delete(args[2]);
    if (args[0] === "tokens") return `proof-token-${args[4]}\n`;
    if (args[0] === "ips" && args[1] === "list") return "[]";
    return "";
  };
  const dependencies = {
    run,
    request,
    secretRoot: directory,
    deploy: () => mutations.push("deploy"),
  };
  return { directory, configPath, apps, reads, mutations, dependencies };
}

test("default production and proof use remote stores with isolated app names", () => {
  assert.deepEqual(loadEnvironment(), production);
  assert.equal(production.apps.stores, "checkout-surge-stores");
  for (const path of [
    "core/machine.json",
    "runner/machine.json",
    "gate/machine.json",
    "gate/guard-machine.json",
  ]) {
    const config = JSON.parse(readFileSync(new URL(`./${path}`, import.meta.url), "utf8"));
    const candidate = configureMachine(structuredClone(config), production);
    if (config.metadata.role === "core") {
      assert.equal(candidate.mounts, undefined);
      assert.equal(candidate.containers.filter((c) => c.env?.API_ROLE === "buyer").length, 3);
    }
    const configured = configureMachine(structuredClone(config), proof);
    assert.ok(!JSON.stringify(configured).includes("checkout-surge-core"));
    assert.ok(!JSON.stringify(configured).includes("checkout-surge-runner"));
    assert.ok(!JSON.stringify(configured).includes("checkout-surge-gate"));
  }
});

test("proof files accept an explicit evidence flag and retain the three-app variant", (t) => {
  const f = fixture(t, { ...proof, proofEvidenceCapture: true });
  assert.equal(loadEnvironment(f.configPath).proofEvidenceCapture, true);
  writeFileSync(f.configPath, JSON.stringify({ ...proof, proofEvidenceCapture: "true" }));
  assert.throws(() => loadEnvironment(f.configPath), /must be a boolean/);
  const apps = { core: proof.apps.core, runner: proof.apps.runner, gate: proof.apps.gate };
  writeFileSync(f.configPath, JSON.stringify({ ...proof, apps }));
  const legacy = loadEnvironment(f.configPath);
  const template = JSON.parse(
    readFileSync(new URL("./core/machine.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(configureMachine(structuredClone(template), legacy).mounts, template.mounts);
  assert.ok(configureMachine(template, legacy).containers.some((c) => c.name === "postgres"));
});

test("a production stores app is also forbidden in proof configuration", (t) => {
  const f = fixture(t, { ...proof, apps: { ...proof.apps, stores: production.apps.stores } });
  assert.throws(() => loadEnvironment(f.configPath), /Production apps are forbidden/);
});

for (const [name, environment, sameVersion] of [
  ["default all deploy sends the candidate topology and recovery configs", production, false],
  [
    "same-SHA proof all removes capture with explicit false",
    { ...proof, proofEvidenceCapture: false },
    true,
  ],
  ["same-SHA proof all removes capture with the flag omitted", proof, true],
]) {
  test(name, (t) => {
    const f = fixture(t, environment);
    const template = (role) =>
      JSON.parse(readFileSync(new URL(`./${role}/machine.json`, import.meta.url), "utf8"));
    const oldRunner = sameVersion
      ? configureMachine(template("runner"), {
          ...environment,
          proofEvidenceCapture: true,
        })
      : template("runner");
    oldRunner.env.COMMIT_SHA = sameVersion ? "candidate-sha" : "previous";
    oldRunner.image = `registry.fly.io/${environment.apps.runner}:load-orchestrator-${oldRunner.env.COMMIT_SHA}`;
    if (oldRunner.files)
      oldRunner.files = oldRunner.files.map(({ guest_path, local_path }) => ({
        guest_path,
        raw_value: readFileSync(local_path).toString("base64"),
      }));
    const initial = [
      [environment.apps.gate, [{ id: "gate", state: "stopped", config: template("gate") }]],
      [environment.apps.core, [{ id: "core", state: "stopped", config: template("core") }]],
      [environment.apps.runner, [{ id: "runner", state: "stopped", config: oldRunner }]],
      [environment.apps.stores, []],
    ];
    const preload = join(f.directory, "default-deploy.mjs");
    const resultPath = join(f.directory, "deployed.json");
    writeFileSync(
      preload,
      `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { writeFileSync } from "node:fs";
    const machines = new Map(${JSON.stringify(initial)});
    const builds = [];
    const volumes = [];
    const save = () => writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
      machines: [...machines], builds, volumes,
    }));
    childProcess.execFileSync = (_command, args) => {
      if (args.join(" ") === "auth token") return "mock-token";
      if (_command === "git") return args[0] === "rev-parse" ? "candidate-sha" : "";
      if (args[0] !== "deploy" || !args.includes("--build-only"))
        throw new Error("Unexpected command: " + args.join(" "));
      builds.push(args);
      save();
      return "";
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url, options) => {
      const { pathname } = new URL(url);
      const [, , , app, ...segments] = pathname.split("/");
      const path = segments.length ? "/" + segments.join("/") : "";
      if (!machines.has(app)) throw new Error("Unexpected app: " + app);
      const list = machines.get(app);
      const body = options.body ? JSON.parse(options.body) : undefined;
      let result;
      if (options.method === "GET" && !path) result = { organization: { slug: ${JSON.stringify(environment.organization)} } };
      else if (options.method === "GET" && path === "/machines") result = list;
      else if (options.method === "POST" && path === "/volumes") {
        volumes.push({ app, ...body });
        result = { id: "store-volume" };
      } else if (path.endsWith("/lease")) result = { data: { nonce: "mock-lease" } };
      else if (options.method === "GET" && path.endsWith("/wait")) result = {};
      else if (options.method === "GET") result = list.find((m) => path === "/machines/" + m.id);
      else if (options.method === "POST" && body?.config) {
        const id = path === "/machines" ? body.config.metadata.role : path.split("/").at(-1);
        result = { id, state: "stopped", config: body.config };
        const index = list.findIndex((m) => m.id === id);
        if (index === -1) list.push(result); else list[index] = result;
      } else throw new Error("Unexpected request: " + options.method + " " + path);
      if (!result) throw new Error("Missing mock response: " + path);
      save();
      return new Response(JSON.stringify(result));
    };
  `,
    );
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        preload,
        "infra/fly/deploy.mjs",
        "all",
        ...(environment.name === "proof" ? ["--environment", f.configPath] : []),
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.match(output, /both run version candidate-sha/);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(result.builds.length, 7);
    assert.deepEqual(
      result.volumes.map(({ app, size_gb }) => ({ app, size_gb })),
      [{ app: environment.apps.stores, size_gb: 6 }],
    );
    const machines = new Map(result.machines);
    const core = machines.get(environment.apps.core)[0].config;
    const runner = machines.get(environment.apps.runner)[0].config;
    const gate = machines.get(environment.apps.gate).find((m) => m.id === "gate").config;
    assert.equal(core.mounts, undefined);
    assert.equal(core.containers.filter((c) => c.env?.API_ROLE === "buyer").length, 3);
    assert.equal(runner.guest.cpus, 16);
    assert.equal(runner.env.PROOF_K6_CAPTURE_DIR, undefined);
    assert.equal(runner.files, undefined);
    assert.equal(runner.init, undefined);
    const embedded = (holder, path) =>
      JSON.parse(
        Buffer.from(
          holder.files.find((file) => file.guest_path === path).raw_value,
          "base64",
        ).toString("utf8"),
      );
    const api = core.containers.find((c) => c.name === "api");
    assert.deepEqual(embedded(api, api.env.RUNNER_MACHINE_CONFIG_FILE), runner);
    assert.deepEqual(embedded(gate, gate.env.CORE_MACHINE_CONFIG_FILE), core);
    assert.equal(gate.env.STORES_FLY_APP, environment.apps.stores);
  });
}

test("production target is refused before any lookup by lifecycle and deploy CLI", async (t) => {
  const f = fixture(t, { ...proof, apps: { ...proof.apps, runner: production.apps.runner } });
  await assert.rejects(operateProof("create", f.configPath, f.dependencies), /Production apps/);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.mutations, []);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["infra/fly/deploy.mjs", "all", "--environment", f.configPath],
        {
          env: { ...process.env, FLYCTL: "must-not-be-executed" },
          stdio: "pipe",
        },
      ),
    (error) => error.stderr.toString().includes("Production apps are forbidden"),
  );
});

for (const action of ["create", "deploy", "destroy"]) {
  test(`${action} refuses mixed organizations before any mutation`, async (t) => {
    const f = fixture(t);
    for (const app of Object.values(proof.apps)) f.apps.set(app, proof.organization);
    f.apps.set(proof.apps.gate, "another-org");
    await assert.rejects(operateProof(action, f.configPath, f.dependencies), /does not belong/);
    assert.deepEqual(f.mutations, []);
  });
}

test("create, deploy, destroy and recreate use only proof apps and fresh secrets", async (t) => {
  const f = fixture(t);
  await operateProof("create", f.configPath, f.dependencies);
  const first = readFileSync(join(f.directory, proof.apps.gate, "core.env"), "utf8");
  assert.ok(first.includes("ADMIN_DASHBOARD_PASSPHRASE="));
  const imports = f.mutations.filter((call) => call.args[0] === "secrets");
  assert.equal(imports.length, Object.keys(proof.apps).length);
  const control = imports[0].input.match(/CONTROL_SERVICE_TOKEN=(.+)/)[1];
  assert.ok(imports[1].input.includes(`CONTROL_SERVICE_TOKEN=${control}`));
  assert.ok(imports[2].input.includes("CORE_FLY_API_TOKEN=proof-token-"));
  assert.ok(imports[0].input.includes(`@${proof.apps.stores}.internal:5432`));
  assert.ok(imports[2].input.includes("STORES_FLY_API_TOKEN=proof-token-"));
  assert.ok(imports[3].input.includes("POSTGRES_PASSWORD="));
  assert.ok(f.reads.every((app) => Object.values(proof.apps).includes(app)));
  await operateProof("deploy", f.configPath, f.dependencies);
  assert.equal(f.mutations.at(-1), "deploy");
  await operateProof("destroy", f.configPath, f.dependencies);
  assert.equal(f.apps.size, 0);
  await operateProof("create", f.configPath, f.dependencies);
  assert.notEqual(readFileSync(join(f.directory, proof.apps.gate, "core.env"), "utf8"), first);
});

test("an ownership change during create stops subsequent mutations", async (t) => {
  const f = fixture(t);
  const run = f.dependencies.run;
  f.dependencies.run = (args, options) => {
    const result = run(args, options);
    f.apps.set(proof.apps.core, "another-org");
    return result;
  };
  await assert.rejects(operateProof("create", f.configPath, f.dependencies), /does not belong/);
  assert.equal(f.mutations.length, 1);
});

test("missing deploy apps and app lookup errors fail closed", async () => {
  await assert.rejects(
    verifyApps(proof, async () => {
      throw Object.assign(new Error("Not found"), { status: 404 });
    }),
    /Not found/,
  );
  await assert.rejects(
    verifyApps(
      proof,
      async () => {
        throw Object.assign(new Error("Unauthorized"), { status: 401 });
      },
      true,
    ),
    /Unauthorized/,
  );
});

test("deploy CLI checks every app organization before builds or Machine reads", (t) => {
  const f = fixture(t);
  const preload = join(f.directory, "fake-fly.mjs");
  const marker = join(f.directory, "unexpected-call");
  writeFileSync(
    preload,
    `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { writeFileSync } from "node:fs";
    childProcess.execFileSync = (_command, args) => {
      if (args.join(" ") === "auth token") return "fake-proof-token";
      writeFileSync(${JSON.stringify(marker)}, args.join(" "));
      throw new Error("Unexpected command before safety validation");
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url, options) => {
      if (options.method !== "GET" || !url.endsWith(url.includes("gate") ? "gate" : url.includes("runner") ? "runner" : "core")) {
        writeFileSync(${JSON.stringify(marker)}, url);
        throw new Error("Unexpected Machine access");
      }
      return new Response(JSON.stringify({organization:{slug:url.includes("gate") ? "wrong-org" : "playground-416"}}));
    };
  `,
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        ["--import", preload, "infra/fly/deploy.mjs", "all", "--environment", f.configPath],
        { stdio: "pipe" },
      ),
    (error) => error.stderr.toString().includes("does not belong"),
  );
  assert.equal(existsSync(marker), false);
});

for (const local of [false, true]) {
  test(`${local ? "local push" : "remote build"} refuses an organization changed after the first image`, (t) => {
    const f = fixture(t);
    const preload = join(f.directory, "build-fly.mjs");
    const callsPath = join(f.directory, "build-calls.json");
    writeFileSync(
      preload,
      `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      import { writeFileSync } from "node:fs";
      const calls = [];
      let changed = false;
      childProcess.execFileSync = (command, args) => {
        if (args.join(" ") === "auth token") return "fake-proof-token";
        if (command === "git") return args[0] === "rev-parse" ? "proof-commit" : "";
        if (args.join(" ") === "auth docker") return "";
        calls.push([command, ...args]);
        writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
        if (args[0] === "deploy" || args[0] === "push") changed = true;
        return "";
      };
      syncBuiltinESMExports();
      globalThis.fetch = async (url, options) => {
        if (options.method !== "GET") throw new Error("Unexpected mutation");
        return new Response(JSON.stringify(url.endsWith("/machines") ? [] : {
          organization: {slug: changed && url.endsWith("-core") ? "wrong-org" : "playground-416"}
        }));
      };
    `,
    );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            "--import",
            preload,
            "infra/fly/deploy.mjs",
            "all",
            "--environment",
            f.configPath,
            ...(local ? ["--local-build"] : []),
          ],
          { stdio: "pipe" },
        ),
      (error) => error.stderr.toString().includes("does not belong"),
    );
    const calls = JSON.parse(readFileSync(callsPath, "utf8"));
    assert.equal(calls.filter((call) => call[1] === (local ? "push" : "deploy")).length, 1);
    if (local) assert.equal(calls.filter((call) => call[1] === "build").length, 2);
  });
}
