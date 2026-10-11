import { writeFileSync } from "node:fs";
import { contracts, db } from "./common.mjs";

const [comparison, preset = "smoke", repetitions = "6", output] = process.argv.slice(2);
if (!["redis", "queue"].includes(comparison)) throw new Error("Choose redis or queue comparison.");
const pairs = Number(repetitions);
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 12)
  throw new Error("Use 1-12 paired repetitions.");
const seed = db
  .buildSeedPresets()
  .find((item) => item.slug === (preset === "slow-erp-5k" ? preset : "surge-5k"));
const snapshot = {
  trafficConfig: seed.trafficConfig,
  inventoryConfig: seed.inventoryConfig,
  erpConfig: seed.erpConfig,
  backpressureConfig: seed.backpressureConfig,
};
if (preset === "smoke") {
  snapshot.trafficConfig = {
    mode: "buyer-spike",
    buyerCount: 32,
    maxDurationSeconds: 20,
    startDelaySeconds: 0,
  };
  snapshot.inventoryConfig = { startingStock: 32 };
  snapshot.erpConfig = { latencyMs: 0, maxTps: 1000, errorRate: 0, forcedOutage: false };
} else if (preset === "sold-out" || preset === "ca-300x10") {
  snapshot.trafficConfig = {
    mode: "constant-arrival-rate",
    ratePerSecond: preset === "sold-out" ? 2500 : 300,
    durationSeconds: 10,
    startDelaySeconds: 0,
    k6Vus: { preAllocatedVus: 10000, maxVus: 10000 },
  };
  snapshot.inventoryConfig = { startingStock: preset === "sold-out" ? 1 : 1000 };
  if (preset === "sold-out")
    snapshot.erpConfig = { latencyMs: 0, maxTps: 1000, errorRate: 0, forcedOutage: false };
} else if (!["surge-5k", "slow-erp-5k"].includes(preset))
  throw new Error("Unknown feasibility preset.");
const plan = {
  modes: comparison === "redis" ? ["demo", "no-redis"] : ["demo", "no-queue"],
  pairs,
  preset,
  snapshot: contracts.acceptedRunConfigSnapshotSchema.parse(snapshot),
};
const text = `${JSON.stringify(plan, null, 2)}\n`;
if (output) writeFileSync(output, text);
else process.stdout.write(text);
