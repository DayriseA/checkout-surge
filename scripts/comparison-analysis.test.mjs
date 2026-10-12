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

function redisRecord(pairId, comparisonMode, postgresTransactions) {
  return {
    label: "redis-comparison",
    pairId,
    comparisonMode,
    status: "completed",
    droppedIterations: 0,
    requests: { completedRequests: 10_000 },
    responses: {
      acceptedResponses: 1,
      soldOutResponses: 9_999,
      buyerWallLatencySummary: {
        accepted: null,
        soldOut: { sampleCount: 9_999, averageMs: 3, p95Ms: 8, maxMs: 40 },
      },
    },
    storeLoad: { postgresTransactions, postgresBusyMs: postgresTransactions / 10, redisCpuMs: 500 },
  };
}

test("reads a Redis comparison's database work per mode and per buyer", () => {
  const comparison = {
    modes: ["redis", "postgres"],
    titles: ["With Redis", "Stock in PostgreSQL"],
    secondRun: "with the stock in PostgreSQL",
  };
  const records = [
    redisRecord("pair-1", "redis", 200),
    redisRecord("pair-1", "postgres", 10_200),
    redisRecord("pair-2", "redis", 400),
    redisRecord("pair-2", "postgres", 10_400),
  ];
  const table = comparisonTable(pairsOf(records, comparison.modes), comparison);
  assert.ok(
    table.includes(
      "| PostgreSQL transactions | 300 (200–400) | 10300 (10200–10400) | 38.5 (26–51) | all higher with the stock in PostgreSQL |",
    ),
  );
  assert.ok(table.includes("| PostgreSQL transactions per buyer | 0.03 (0.02–0.04) | 1 (1–1) |"));
});
