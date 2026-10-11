import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { configureMachine, loadEnvironment } from "../environment.mjs";
import {
  collectResources,
  intervalCpuPercent,
  parseProcessStat,
  startObserver,
} from "./proof-observer.mjs";

function stat(parent, start = "100") {
  const fields = Array(22).fill("0");
  fields[0] = "R";
  fields[1] = String(parent);
  fields[11] = "12";
  fields[12] = "8";
  fields[19] = start;
  fields[21] = "20";
  return `42 (name with ) parentheses) ${fields.join(" ")}`;
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "proof-observer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = new Map([
    ["/proc/sys/kernel/random/boot_id", "kernel-boot"],
    [`/proc/${process.ppid}/stat`, stat(1)],
    [`/proc/${process.pid}/stat`, stat(process.ppid, "200")],
    ["/sys/fs/cgroup/cpu.stat", "usage_usec 1000"],
    ["/sys/fs/cgroup/cpu.max", "1600000 100000"],
    ["/sys/fs/cgroup/memory.current", "123456"],
    ["/sys/fs/cgroup/memory.max", "34359738368"],
    ["/sys/fs/cgroup/memory.swap.current", "0"],
    ["/sys/fs/cgroup/memory.events", "oom_kill 0"],
  ]);
  let time = 0,
    free = 200 * 1024 * 1024;
  const ready = path.join(root, "ready.json");
  const options = {
    base: path.join(root, "resources"),
    read: (file) => files.get(file) ?? null,
    list: () => [],
    hostCores: 16,
    monotonic: () => time,
    now: () => 1_700_000_000_000 + time,
    freeBytes: () => free,
    environment: {
      FLY_APP_NAME: "cs-proof-redis-queue-runner",
      FLY_MACHINE_ID: "machine",
      COMMIT_SHA: "commit",
    },
  };
  return {
    root,
    ready,
    options,
    files,
    setTime: (value) => {
      time = value;
    },
    setFree: (value) => {
      free = value;
    },
  };
}

test("resource parsers retain real process identity and v1/v2 counters without inventing missing values", () => {
  assert.deepEqual(parseProcessStat(stat(70, "901")), {
    state: "R",
    parentPid: 70,
    startTicks: "901",
    userTicks: "12",
    systemTicks: "8",
    rssPages: "20",
  });
  const files = new Map([
    ["/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage", "123456789"],
    ["/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us", "1600000"],
    ["/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us", "100000"],
    ["/sys/fs/cgroup/memory/memory.usage_in_bytes", "123"],
    ["/proc/42/comm", "k6"],
    ["/proc/42/stat", stat(70, "901")],
  ]);
  const point = collectResources(
    (file) => files.get(file) ?? null,
    () => ["42"],
    32,
  );
  assert.equal(point.cgroupVersion, 1);
  assert.equal(point.usageUsec, "123456");
  assert.equal(point.allocationCores, 16);
  assert.equal(point.memoryBytes, "123");
  assert.equal(point.memorySwapBytes, null);
  assert.equal(point.memoryEvents, null);
  assert.equal(point.k6[0].startTicks, "901");
  assert.equal(point.processScanComplete, true);
  files.delete("/proc/42/stat");
  assert.equal(
    collectResources(
      (file) => files.get(file) ?? null,
      () => ["42"],
    ).processScanComplete,
    false,
  );
  const previous = { monotonicMs: 0, usageUsec: "0", allocationCores: 16 };
  const current = { monotonicMs: 250, usageUsec: "3200000", allocationCores: 16 };
  assert.equal(intervalCpuPercent(previous, current), 80);
  assert.equal(intervalCpuPercent(previous, { ...current, monotonicMs: 500 }), null);
  assert.equal(intervalCpuPercent(previous, { ...current, usageUsec: null }), null);
  assert.equal(intervalCpuPercent(current, { ...current, monotonicMs: 500, usageUsec: "1" }), null);
});

test("fresh baseline precedes readiness; signal finalization hashes stable exact files and records gaps as unknown", (t) => {
  const f = fixture(t);
  const observer = startObserver(f.ready, f.options);
  t.after(() => observer.stop("test-cleanup"));
  const ready = JSON.parse(readFileSync(f.ready, "utf8"));
  assert.equal(ready.directory, observer.directory);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(f.options.base, "current.json"), "utf8")),
    ready,
  );
  assert.equal(ready.baselineEpochMs, 1_700_000_000_000);
  f.setTime(250);
  f.files.set("/sys/fs/cgroup/cpu.stat", "usage_usec 3201000");
  observer.tick();
  f.setTime(750);
  f.files.delete("/sys/fs/cgroup/cpu.stat");
  observer.tick();
  observer.stop("SIGTERM");
  const points = readFileSync(path.join(observer.directory, "samples.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(points[0].cpuPercent, null);
  assert.equal(points[1].cpuPercent, 80);
  assert.equal(points[2].usageUsec, null);
  assert.equal(points[2].cpuPercent, null);
  assert.equal(points[2].probeComplete, false);
  const manifest = JSON.parse(readFileSync(path.join(observer.directory, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "finalized");
  assert.equal(manifest.reason, "SIGTERM");
  assert.deepEqual(Object.keys(manifest.files), [
    "metadata.json",
    "samples.jsonl",
    "finished.json",
  ]);
  for (const [name, description] of Object.entries(manifest.files)) {
    const data = readFileSync(path.join(observer.directory, name));
    assert.deepEqual(description, {
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  assert.throws(() => startObserver(f.ready, f.options), /fresh/);
});

test("missing startup baseline blocks readiness and preserves a partial manifest", (t) => {
  const f = fixture(t);
  f.files.delete("/sys/fs/cgroup/cpu.stat");
  assert.throws(() => startObserver(f.ready, f.options), /pre-server baseline/);
  assert.equal(existsSync(f.ready), false);
  assert.equal(existsSync(path.join(f.options.base, "current.json")), false);
  const directory = path.join(f.options.base, readdirSync(f.options.base)[0]);
  assert.equal(
    JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")).status,
    "partial",
  );
});

test("parent reuse, elapsed lifetime and free-space exhaustion stop collection with partial evidence", (t) => {
  for (const reason of ["parent-exited", "bounded-lifetime", "probe-or-storage-failure"]) {
    const f = fixture(t);
    const observer = startObserver(f.ready, f.options);
    t.after(() => observer.stop("test-cleanup"));
    if (reason === "parent-exited") f.files.set(`/proc/${process.ppid}/stat`, stat(1, "999"));
    if (reason === "bounded-lifetime") f.setTime(960_000);
    if (reason === "probe-or-storage-failure") f.setFree(0);
    observer.tick();
    const manifest = JSON.parse(
      readFileSync(path.join(observer.directory, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.status, "partial");
    assert.equal(manifest.reason, reason);
    const before = readFileSync(path.join(observer.directory, "samples.jsonl"), "utf8");
    observer.tick();
    assert.equal(readFileSync(path.join(observer.directory, "samples.jsonl"), "utf8"), before);
  }
});

test("proof startup refuses an exited observer before launching the unchanged application", (t) => {
  const f = fixture(t);
  const fakeNode = path.join(f.root, "node");
  const launched = path.join(f.root, "app-launched");
  writeFileSync(
    fakeNode,
    `#!/bin/sh\nif [ "$1" = /app/proof-observer.mjs ]; then exit 1; fi\ntouch '${launched}'\n`,
    { mode: 0o755 },
  );
  const proof = loadEnvironment(new URL("../proof.json", import.meta.url));
  const template = JSON.parse(readFileSync(new URL("./machine.json", import.meta.url), "utf8"));
  const runner = configureMachine(template, proof);
  const result = spawnSync(runner.cmd[0], runner.cmd.slice(1), {
    env: { ...process.env, PATH: `${f.root}:${process.env.PATH}` },
    timeout: 11_000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(existsSync(launched), false);
});
