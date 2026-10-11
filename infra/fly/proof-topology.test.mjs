import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { configureMachine, loadEnvironment } from "./environment.mjs";
import { waitForStores } from "./wait-for-stores.mjs";

const proof = loadEnvironment(new URL("./proof.json", import.meta.url));
const template = (role) =>
  JSON.parse(readFileSync(new URL(`./${role}/machine.json`, import.meta.url), "utf8"));

test("proof moves stores out and installs one authority with three buyers and private ingress", () => {
  const core = configureMachine(template("core"), proof);
  assert.equal(core.mounts, undefined);
  assert.ok(!core.containers.some((c) => ["postgres", "redis"].includes(c.name)));
  const control = core.containers.find((c) => c.name === "api");
  const buyers = core.containers.filter((c) => c.env?.API_ROLE === "buyer");
  assert.equal(control.env.API_ROLE, "control");
  assert.equal(buyers.length, 3);
  assert.deepEqual(
    buyers.map((c) => c.env.PORT),
    ["4001", "4002", "4003"],
  );
  assert.ok(buyers.every((c) => c.env.API_CONTROL_BASE_URL === "http://127.0.0.1:4000"));
  assert.equal(control.env.WORKER_BASE_URL, "http://127.0.0.1:4300");
  assert.ok(buyers.every((c) => c.env.WORKER_BASE_URL === control.env.WORKER_BASE_URL));
  assert.ok(buyers.every((c) => !c.env.CORE_IDLE_STOP_ENABLED && !c.env.RUNNER_FLY_APP));
  assert.ok(control.cmd[2].includes("[$FLY_PRIVATE_IP]:4004"));
  assert.equal(
    core.containers.find((c) => c.name === "web").env.API_BASE_URL,
    "http://127.0.0.1:4004",
  );
  assert.ok(
    core.containers.every(
      (c) =>
        c.depends_on?.every((d) => core.containers.some((peer) => peer.name === d.name)) ?? true,
    ),
  );
  const stores = template("core");
  stores.metadata.role = "stores";
  configureMachine(stores, proof);
  assert.deepEqual(
    stores.containers.map((c) => c.name),
    ["postgres", "redis"],
  );
  assert.deepEqual(stores.guest, { cpu_kind: "performance", cpus: 2, memory_mb: 4096 });
  assert.ok(stores.containers[0].cmd[2].includes("listen_addresses='*'"));
  assert.ok(stores.containers[1].cmd[2].includes("--bind 0.0.0.0 ::"));
  assert.equal(stores.services, undefined);
  const runner = configureMachine(template("runner"), proof);
  assert.equal(runner.guest.cpus, 16);
  assert.equal(runner.guest.memory_mb, 32768);
  assert.equal(
    runner.env.PROOF_K6_CAPTURE_DIR,
    `${runner.env.LOAD_ORCHESTRATOR_STATE_DIR}/proof-capture`,
  );
  assert.deepEqual(runner.files, [
    { guest_path: "/app/proof-observer.mjs", local_path: "infra/fly/runner/proof-observer.mjs" },
  ]);
  assert.equal(runner.cmd, undefined);
  assert.deepEqual(runner.init.exec.slice(0, 3), ["/usr/local/bin/fly-entrypoint.sh", "sh", "-c"]);
  assert.ok(runner.init.exec[3].includes("mktemp -d /tmp/proof-observer.XXXXXX"));
  assert.ok(runner.init.exec[3].includes("timeout 10 sh -c"));
  assert.ok(runner.init.exec[3].endsWith("exec node dist/index.js"));
  const original = template("runner");
  assert.deepEqual(configureMachine(structuredClone(original), loadEnvironment()), original);
});

test("store setup retries authentication/connectivity and fails at its finite deadline", async () => {
  let time = 0;
  let calls = 0;
  const options = {
    timeoutMs: 2000,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
  await waitForStores(async () => {
    if (++calls < 2) throw new Error("not ready");
  }, options);
  assert.equal(calls, 2);
  time = 0;
  await assert.rejects(
    waitForStores(async () => {
      throw new Error("bad credentials");
    }, options),
    /deadline/,
  );
});
