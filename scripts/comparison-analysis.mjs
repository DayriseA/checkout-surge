#!/usr/bin/env node
// Summarizes measured comparison pairs: reads the JSON Lines written by capacity-measurement.mjs
// for a comparison preset, drops the first pair as warm-up, and prints a markdown table of each
// metric's median and min-max per mode, with the per-pair ratio and whether every pair agrees.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Each comparison's modes, in run order, with the column titles of its table. */
const comparisons = [
  {
    modes: ["demo", "synchronous_confirmation"],
    titles: ["With the queue", "Without the queue"],
    secondRun: "without the queue",
  },
  {
    modes: ["redis", "postgres"],
    titles: ["With Redis", "Stock in PostgreSQL"],
    secondRun: "with the stock in PostgreSQL",
  },
];

/** Every metric covers all buyers of the run. Null means not recorded. */
export function redisRunMetrics(record) {
  const { responses, requests, storeLoad, droppedIterations } = record;
  const soldOut = responses.buyerWallLatencySummary?.soldOut ?? null;
  const perBuyer = (value) =>
    value == null || !requests.completedRequests ? null : value / requests.completedRequests;
  return {
    "Buyers secured": responses.acceptedResponses,
    "Buyers turned away": responses.soldOutResponses,
    "Dropped arrivals": droppedIterations,
    "PostgreSQL transactions": storeLoad?.postgresTransactions ?? null,
    "PostgreSQL busy time (ms)": storeLoad?.postgresBusyMs ?? null,
    "PostgreSQL transactions per buyer": perBuyer(storeLoad?.postgresTransactions),
    "PostgreSQL busy time per buyer (ms)": perBuyer(storeLoad?.postgresBusyMs),
    "Redis CPU time (ms)": storeLoad?.redisCpuMs ?? null,
    "Turned-away buyers' average wait (ms)": soldOut?.averageMs ?? null,
    "Turned-away buyers' p95 wait (ms)": soldOut?.p95Ms ?? null,
    "Turned-away buyers' longest wait (ms)": soldOut?.maxMs ?? null,
  };
}

/** Every metric covers all winners or all buyers of the run. Null means not recorded. */
export function runMetrics(record) {
  const { responses, business, arrival, signals } = record;
  const accepted = responses.buyerWallLatencySummary?.accepted ?? null;
  const soldOut = responses.buyerWallLatencySummary?.soldOut ?? null;
  const confirmed = responses.confirmedResponses ?? null;
  const convergence = signals?.convergenceDurationSeconds ?? null;
  const soldOutMax = responses.soldOutResponses === 0 ? 0 : (soldOut?.maxMs ?? null);
  return {
    "Winners' average wait (ms)": accepted?.averageMs ?? null,
    "Winners' p95 wait (ms)": accepted?.p95Ms ?? null,
    "Every buyer answered within (ms)":
      accepted && soldOutMax !== null ? Math.max(accepted.maxMs, soldOutMax) : null,
    "Winners told confirmed": confirmed,
    "Winners told still being confirmed":
      confirmed === null || responses.acceptedResponses === null
        ? null
        : responses.acceptedResponses - confirmed,
    "Orders confirmed": business.confirmedOrders,
    "ERP pace (orders/s)":
      convergence === null
        ? null
        : business.confirmedOrders / (arrival.dispatchDurationSeconds + convergence),
    "Slowest order, secured to confirmed (ms)": signals?.confirmationConvergence?.maxLagMs ?? null,
  };
}

/** Pairs in file order, one per start: both runs of a start share its `pairId`. */
export function pairsOf(records, modes = comparisons[0].modes) {
  const byPair = new Map();
  for (const record of records) {
    if (!modes.includes(record.comparisonMode)) continue;
    // Records written before pairId existed fall back to their label.
    const key = record.pairId ?? record.label;
    const pair = byPair.get(key) ?? { label: record.label };
    pair[record.comparisonMode] = record;
    byPair.set(key, pair);
  }
  return [...byPair.values()].filter((pair) =>
    modes.every((mode) => pair[mode]?.status === "completed"),
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function spread(values) {
  if (values.some((value) => value === null)) return "not recorded";
  // Per-buyer values are fractions: keep two significant digits below one.
  const round = (value) =>
    Number.isInteger(value)
      ? value
      : Number(Math.abs(value) < 1 ? value.toPrecision(2) : value.toFixed(1));
  return `${round(median(values))} (${round(Math.min(...values))}–${round(Math.max(...values))})`;
}

export function comparisonTable(pairs, comparison = comparisons[0]) {
  const { modes, titles, secondRun } = comparison;
  const metricsOf = modes[0] === "redis" ? redisRunMetrics : runMetrics;
  const metrics = pairs.map((pair) => modes.map((mode) => metricsOf(pair[mode])));
  const names = Object.keys(metrics[0]?.[0] ?? {});
  const rows = names.map((name) => {
    const queued = metrics.map(([demo]) => demo[name]);
    const waiting = metrics.map(([, sync]) => sync[name]);
    const known = queued.every((v) => v !== null) && waiting.every((v) => v !== null);
    const ratios = known && queued.every((v) => v > 0) ? waiting.map((v, i) => v / queued[i]) : [];
    const direction = !known
      ? "–"
      : waiting.every((v, i) => v > queued[i])
        ? `all higher ${secondRun}`
        : waiting.every((v, i) => v < queued[i])
          ? `all lower ${secondRun}`
          : waiting.every((v, i) => v === queued[i])
            ? "all equal"
            : "mixed";
    return `| ${name} | ${spread(queued)} | ${spread(waiting)} | ${ratios.length ? spread(ratios) : "–"} | ${direction} |`;
  });
  return [
    `${pairs.length} pairs. Median (min–max).`,
    "",
    `| Metric | ${titles[0]} | ${titles[1]} | Ratio run 2/run 1 | Pairs |`,
    "| :-- | --: | --: | --: | :-- |",
    ...rows,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: node comparison-analysis.mjs <results.jsonl>");
    process.exitCode = 1;
  } else {
    const records = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    // The file's comparison is the one whose modes its records carry. The first pair is the warm-up.
    const comparison =
      comparisons.find(({ modes }) => records.some((r) => r.comparisonMode === modes[0])) ??
      comparisons[0];
    console.log(comparisonTable(pairsOf(records, comparison.modes).slice(1), comparison));
  }
}
