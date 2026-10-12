import assert from "node:assert/strict";
import test from "node:test";
import { toStartRequest } from "./capacity-measurement.mjs";
import { comparisonTable, pairsOf } from "./comparison-analysis.mjs";

test("a comparison preset entry starts the preset as defined", () => {
  assert.deepEqual(toStartRequest({ label: "pair-1", presetSlug: "queue-comparison" }), {
    presetSlug: "queue-comparison",
  });
});

function record(label, comparisonMode, winnerP95Ms, confirmed) {
  return {
    label: "queue-comparison",
    pairId: label,
    comparisonMode,
    status: "completed",
    responses: {
      acceptedResponses: 500,
      confirmedResponses: confirmed,
      soldOutResponses: 4500,
      buyerWallLatencySummary: {
        accepted: {
          sampleCount: 500,
          averageMs: winnerP95Ms / 2,
          p95Ms: winnerP95Ms,
          maxMs: winnerP95Ms,
        },
        soldOut: { sampleCount: 4500, averageMs: 400, p95Ms: 900, maxMs: 1000 },
      },
    },
    business: { confirmedOrders: 500 },
    arrival: { dispatchDurationSeconds: 1 },
    signals: { convergenceDurationSeconds: 29, confirmationConvergence: { maxLagMs: 30000 } },
  };
}

test("pairs every completed pair and reports the spread and whether all pairs agree", () => {
  const records = [
    record("pair-1", "demo", 2000, 0),
    record("pair-1", "synchronous_confirmation", 30000, 500),
    record("pair-2", "demo", 3000, 0),
    record("pair-2", "synchronous_confirmation", 33000, 500),
    { ...record("pair-3", "demo", 2500, 0), status: "failed" },
  ];
  const pairs = pairsOf(records);
  assert.deepEqual(
    pairs.map((pair) => pair.demo.pairId),
    ["pair-1", "pair-2"],
  );
  const table = comparisonTable(pairs);
  assert.ok(
    table.includes(
      "| Winners' p95 wait (ms) | 2500 (2000–3000) | 31500 (30000–33000) | 13 (11–15) | all higher without the queue |",
    ),
  );
  assert.ok(
    table.includes(
      "| ERP pace (orders/s) | 16.7 (16.7–16.7) | 16.7 (16.7–16.7) | 1 (1–1) | all equal |",
    ),
  );
});
