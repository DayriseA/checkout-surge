// Builds the run lists of the comparative-runs study: three presets x ERP on/off x two repetitions.
import { writeFileSync } from "node:fs";

const spike = (buyerCount, maxDurationSeconds) => ({
  mode: "buyer-spike", buyerCount, maxDurationSeconds, startDelaySeconds: 0,
});
const presets = {
  "surge-5k": { ...spike(5000, 80), startingStock: 500, erpLatencyMs: 100, erpMaxTps: 20 },
  "slow-erp-5k": { ...spike(5000, 80), startingStock: 500, erpLatencyMs: 100, erpMaxTps: 5 },
  "ca-300x10": {
    mode: "constant-arrival-rate", ratePerSecond: 300, durationSeconds: 10,
    preAllocatedVus: 10000, maxVus: 10000, startDelaySeconds: 0,
    startingStock: 1000, erpLatencyMs: 100, erpMaxTps: 20,
  },
};
const noErp = { erpLatencyMs: 0, erpMaxTps: 1000 };
const runs = [];
for (const rep of [1, 2])
  for (const [name, preset] of Object.entries(presets))
    for (const erp of ["erp", "noerp"])
      runs.push({
        label: `${name}-${erp}-r${rep}`,
        ...preset,
        ...(erp === "noerp" ? noErp : {}),
        erpErrorRate: 0,
        orderProcessConcurrency: 5,
      });
const warmup = [{
  label: "warmup", ...spike(1000, 30), startingStock: 100, erpLatencyMs: 0, erpMaxTps: 1000,
  erpErrorRate: 0, orderProcessConcurrency: 5,
}];
writeFileSync("runs/warmup.json", JSON.stringify(warmup, null, 2));
writeFileSync("runs/grid.json", JSON.stringify(runs, null, 2));
console.log(runs.map((r) => r.label).join(" "));
