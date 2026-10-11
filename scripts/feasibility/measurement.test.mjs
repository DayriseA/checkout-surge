import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadLab, machineConfigs, operateLab } from "../../infra/fly/feasibility/lab.mjs";
import { readCgroupSample } from "./cgroup.mjs";
import { interleave, iterationMetrics, validity } from "./run-matrix.mjs";

test("CPU/memory samples support observed v2 and Fly v1 controller mounts", async () => {
  for (const fixture of [
    {
      version: 2,
      cpuPath: "/sys/fs/cgroup/cpu.stat",
      cpu: "usage_usec 1234\n",
      memoryPath: "/sys/fs/cgroup/memory.current",
    },
    {
      version: 1,
      cpuPath: "/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage",
      cpu: "1234000\n",
      memoryPath: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    },
    {
      version: 1,
      cpuPath: "/sys/fs/cgroup/cpuacct/cpuacct.usage",
      cpu: "1234000\n",
      memoryPath: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    },
  ]) {
    const files = { [fixture.cpuPath]: fixture.cpu, [fixture.memoryPath]: "8192\n" };
    const sample = await readCgroupSample(async (path) => {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path];
    });
    assert.equal(sample.cgroupVersion, fixture.version);
    assert.equal(sample.usageUsec, 1234);
    assert.equal(sample.memoryBytes, 8192);
    assert.equal(sample.cgroup, "usage_usec 1234\n");
  }
});

test("retained comparisons alternate order across six paired repetitions", () => {
  const schedule = interleave(["demo", "no-redis"], 6);
  assert.deepEqual(schedule.slice(0, 4), [
    { mode: "demo", pair: 1 },
    { mode: "no-redis", pair: 1 },
    { mode: "no-redis", pair: 2 },
    { mode: "demo", pair: 2 },
  ]);
  assert.equal(schedule.length, 12);
});

test("incomplete delivery or a missing final API observer invalidates Redis performance evidence", () => {
  const run = { snapshot: { trafficConfig: { mode: "buyer-spike", buyerCount: 4 } } };
  const points = {
    started: 4,
    completed: 4,
    invalidAttribution: 0,
    outcomes: { reservation_secured: 1, sold_out: 3 },
  };
  const evidence = {
    correctness: { noOversell: true, settled: true },
    business: { orders: 1 },
    counters: [
      { counts: { started: 2, completed: 2, accepted: 1, soldOut: 1, failed: 0 } },
      { counts: { started: 2, completed: 2, accepted: 0, soldOut: 2, failed: 0 } },
    ],
  };
  assert.ok(Object.values(validity(run, points, evidence, 2)).every(Boolean));
  const fullWithDrop = validity(
    {
      snapshot: {
        trafficConfig: { mode: "constant-arrival-rate", ratePerSecond: 2, durationSeconds: 2 },
      },
    },
    points,
    evidence,
    2,
    iterationMetrics({
      metrics: { dropped_iterations: { count: 1 }, buyer_capped_iterations: { count: 1 } },
    }),
  );
  assert.equal(fullWithDrop.fullPlannedDelivery, true);
  assert.equal(fullWithDrop.noReportedDroppedIterations, false);
  assert.equal(validity(run, { ...points, completed: 3 }, evidence, 2).fullPlannedDelivery, false);
  assert.equal(
    validity(run, points, { ...evidence, counters: evidence.counters.slice(0, 1) }, 2)
      .observerComplete,
    false,
  );
});

test("raw generator iteration metrics retain explicit counts and missing values", () => {
  assert.deepEqual(iterationMetrics({ metrics: {} }), {
    droppedIterations: null,
    cappedIterations: null,
  });
  assert.deepEqual(
    iterationMetrics({
      metrics: { dropped_iterations: { count: 0 }, buyer_capped_iterations: { count: 1 } },
    }),
    { droppedIterations: 0, cappedIterations: 1 },
  );
});

test("lab refuses production names and checks all app ownership before a mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "feasibility-guard-"));
  const path = join(directory, "lab.json");
  const config = {
    name: "feasibility",
    organization: "playground-416",
    region: "cdg",
    apiCount: 3,
    poolMax: 10,
    storeDelayMs: 0,
    apps: {
      core: "cs-feasibility-test-core",
      stores: "cs-feasibility-test-stores",
      runner: "cs-feasibility-test-runner",
    },
  };
  try {
    writeFileSync(
      path,
      JSON.stringify({ ...config, apps: { ...config.apps, core: "checkout-surge-core" } }),
    );
    assert.throws(() => loadLab(path), /Only an explicit/);
    writeFileSync(path, JSON.stringify(config));
    let mutations = 0;
    await assert.rejects(
      operateLab("stop", path, {
        run: () => {
          mutations++;
        },
        request: async () => ({ organization: { slug: "personal" } }),
      }),
      /refusing changes/,
    );
    assert.equal(mutations, 0);
    const machines = machineConfigs(
      config,
      { core: "lab", stores: "lab", runner: "lab" },
      "volume",
    );
    assert.equal(machines.core.guest.cpus, 6);
    assert.equal(machines.stores.guest.cpus, 2);
    assert.equal(machines.runner.guest.cpus, 16);
    assert.equal(machines.runner.guest.memory_mb, 32768);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
