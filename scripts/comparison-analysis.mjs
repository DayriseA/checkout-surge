#!/usr/bin/env node
// Summarizes measured comparison pairs: reads the JSON Lines written by capacity-measurement.mjs
// for a comparison preset, drops the first pair as warm-up, and prints a markdown table of each
// metric's median and min-max per mode, with the per-pair ratio and whether every pair agrees.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modes = ["demo", "synchronous_confirmation"];

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
      confirmed === null ? null : responses.acceptedResponses - confirmed,
    "Orders confirmed": business.confirmedOrders,
    "ERP pace (orders/s)":
      convergence === null
        ? null
        : business.confirmedOrders / (arrival.dispatchDurationSeconds + convergence),
    "Slowest order, secured to confirmed (ms)": signals?.confirmationConvergence?.maxLagMs ?? null,
  };
}

/** Pairs in file order: each label holds one run per mode. */
export function pairsOf(records) {
  const byLabel = new Map();
  for (const record of records) {
    if (!modes.includes(record.comparisonMode)) continue;
    const pair = byLabel.get(record.label) ?? {};
    pair[record.comparisonMode] = record;
    byLabel.set(record.label, pair);
  }
  return [...byLabel.entries()]
    .filter(([, pair]) => modes.every((mode) => pair[mode]?.status === "completed"))
    .map(([label, pair]) => ({ label, ...pair }));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function spread(values) {
  if (values.some((value) => value === null)) return "not recorded";
  const round = (value) => (Number.isInteger(value) ? value : Number(value.toFixed(1)));
  return `${round(median(values))} (${round(Math.min(...values))}–${round(Math.max(...values))})`;
}

export function comparisonTable(pairs) {
  const metrics = pairs.map((pair) => modes.map((mode) => runMetrics(pair[mode])));
  const names = Object.keys(metrics[0]?.[0] ?? {});
  const rows = names.map((name) => {
    const queued = metrics.map(([demo]) => demo[name]);
    const waiting = metrics.map(([, sync]) => sync[name]);
    const known = queued.every((v) => v !== null) && waiting.every((v) => v !== null);
    const ratios = known && queued.every((v) => v > 0) ? waiting.map((v, i) => v / queued[i]) : [];
    const direction = !known
      ? "–"
      : waiting.every((v, i) => v > queued[i])
        ? "all higher without the queue"
        : waiting.every((v, i) => v < queued[i])
          ? "all lower without the queue"
          : waiting.every((v, i) => v === queued[i])
            ? "all equal"
            : "mixed";
    return `| ${name} | ${spread(queued)} | ${spread(waiting)} | ${ratios.length ? spread(ratios) : "–"} | ${direction} |`;
  });
  return [
    `Pairs: ${pairs.map((pair) => pair.label).join(", ")}. Median (min–max).`,
    "",
    "| Metric | With the queue | Without the queue | Ratio without/with | Pairs |",
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
    // The first pair is the warm-up.
    console.log(comparisonTable(pairsOf(records).slice(1)));
  }
}
