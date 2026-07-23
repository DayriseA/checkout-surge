import assert from "node:assert/strict";
import { test } from "node:test";
import { runInCompose } from "./run-in-compose.mjs";

function createSpawn(results) {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return results.shift();
    },
  };
}

test("uses the host-local script when the API service is not running", () => {
  const fake = createSpawn([{ status: 0, stdout: "" }, { status: 7 }]);

  const status = runInCompose({
    script: "scripts/runtime-smoke.mjs",
    args: ["--verbose"],
    spawn: fake.spawn,
  });

  assert.equal(status, 7);
  assert.deepEqual(fake.calls[1].args, ["scripts/runtime-smoke.mjs", "--verbose"]);
  assert.equal(fake.calls[1].command, process.execPath);
});

test("uses the profile-gated runtime-tools service when API is running", () => {
  const fake = createSpawn([{ status: 0, stdout: "container-id\n" }, { status: 0 }]);

  const status = runInCompose({
    script: "scripts/maintenance-cleanup-runs.mjs",
    args: ["--older-than-days", "1"],
    spawn: fake.spawn,
  });

  assert.equal(status, 0);
  assert.deepEqual(fake.calls[1].args, [
    "compose",
    "--profile",
    "tools",
    "run",
    "--rm",
    "--build",
    "--no-deps",
    "runtime-tools",
    "node",
    "scripts/maintenance-cleanup-runs.mjs",
    "--older-than-days",
    "1",
  ]);
});

test("reports a tooling spawn failure without hiding the script name", () => {
  const fake = createSpawn([
    { status: 0, stdout: "container-id\n" },
    { error: new Error("docker unavailable") },
  ]);
  const errors = [];

  const status = runInCompose({
    script: "scripts/runtime-reset.mjs",
    spawn: fake.spawn,
    writeError: (message) => errors.push(message),
  });

  assert.equal(status, 1);
  assert.match(errors[0], /runtime-reset\.mjs.*docker unavailable/);
});

test("removes one pnpm argument separator before forwarding tooling arguments", () => {
  const fake = createSpawn([{ status: 0, stdout: "container-id\n" }, { status: 0 }]);

  const status = runInCompose({
    script: "scripts/maintenance-cleanup-runs.mjs",
    args: ["--", "--older-than-days", "1"],
    spawn: fake.spawn,
  });

  assert.equal(status, 0);
  assert.deepEqual(fake.calls[1].args.slice(-3), [
    "scripts/maintenance-cleanup-runs.mjs",
    "--older-than-days",
    "1",
  ]);
});

test("rejects a missing script before spawning", () => {
  const fake = createSpawn([]);
  const errors = [];

  const status = runInCompose({ spawn: fake.spawn, writeError: (message) => errors.push(message) });

  assert.equal(status, 1);
  assert.equal(fake.calls.length, 0);
  assert.match(errors[0], /Usage:/);
});
