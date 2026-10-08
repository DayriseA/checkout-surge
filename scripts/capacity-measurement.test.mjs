import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startDemoRunRequestSchema } from "../packages/contracts/dist/index.js";
import { toStartRequest } from "./capacity-measurement.mjs";

const shared = {
  startDelaySeconds: 0,
  startingStock: 1000,
  erpLatencyMs: 0,
  erpMaxTps: 1000,
  erpErrorRate: 0,
  orderProcessConcurrency: 10,
};

test("run-list entries become contract-valid admin starts carrying every setting", () => {
  const constantArrival = toStartRequest({
    label: "ca",
    mode: "constant-arrival-rate",
    ratePerSecond: 2000,
    durationSeconds: 10,
    preAllocatedVus: 5000,
    maxVus: 10000,
    ...shared,
  });
  assert.deepEqual(startDemoRunRequestSchema.parse(constantArrival).configOverride, {
    trafficConfig: {
      mode: "constant-arrival-rate",
      ratePerSecond: 2000,
      durationSeconds: 10,
      startDelaySeconds: 0,
      quantityPerAttempt: 1,
      k6Vus: { preAllocatedVus: 5000, maxVus: 10000 },
    },
    inventoryConfig: { startingStock: 1000 },
    erpConfig: { latencyMs: 0, maxTps: 1000, errorRate: 0, forcedOutage: false },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 10,
    },
  });

  const buyerSpike = toStartRequest({
    label: "spike",
    mode: "buyer-spike",
    buyerCount: 5000,
    maxDurationSeconds: 60,
    ...shared,
  });
  assert.equal(startDemoRunRequestSchema.parse(buyerSpike).presetSlug, "custom");
  assert.equal(buyerSpike.configOverride.trafficConfig.buyerCount, 5000);
});

test("a constant-arrival run without explicit VUs is refused", () => {
  assert.throws(
    () =>
      toStartRequest({
        label: "ca",
        mode: "constant-arrival-rate",
        ratePerSecond: 2000,
        durationSeconds: 10,
        ...shared,
      }),
    /preAllocatedVus is required/,
  );
});

test("a token that is not a valid header value is refused without printing it", () => {
  const token = "capacity-secret-token\nsecond-line";
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./capacity-measurement.mjs", import.meta.url)),
      "runs.json",
      "out.jsonl",
    ],
    { env: { ...process.env, CONTROL_SERVICE_TOKEN: token }, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONTROL_SERVICE_TOKEN is not a valid HTTP header value/);
  assert.ok(!result.stderr.includes("capacity-secret-token"));
});
