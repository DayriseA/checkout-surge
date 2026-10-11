import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import { readCgroupSample } from "./cgroup.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export function interleave(modes, pairs) {
  if (modes.length !== 2 || !Number.isInteger(pairs) || pairs < 1)
    throw new Error("Configure two modes and a positive pair count.");
  return Array.from({ length: pairs }, (_, pair) =>
    (pair % 2 ? [...modes].reverse() : modes).map((mode) => ({ mode, pair: pair + 1 })),
  ).flat();
}
const quantile = (values, q) =>
  values.length ? values.toSorted((a, b) => a - b)[Math.ceil(q * values.length) - 1] : null;

export async function analyzePoints(path, run) {
  const stream = createReadStream(path).pipe(createGunzip());
  const reader = createInterface({ input: stream });
  const result = {
    started: 0,
    completed: 0,
    outcomes: {},
    latencies: {},
    firstStartedAt: null,
    lastResponseAt: null,
    invalidAttribution: 0,
  };
  for await (const line of reader) {
    const row = JSON.parse(line);
    if (row.type !== "Point" || !["buyer_started", "buyer_result"].includes(row.metric)) continue;
    if (row.data.tags.runId !== run.runId || row.data.tags.mode !== run.mode) {
      result.invalidAttribution++;
      continue;
    }
    if (row.metric === "buyer_started") {
      result.started += row.data.value;
      if (!result.firstStartedAt || row.data.time < result.firstStartedAt)
        result.firstStartedAt = row.data.time;
    } else {
      result.completed++;
      const outcome = row.data.tags.outcome;
      result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
      result.latencies[outcome] ??= [];
      result.latencies[outcome].push(row.data.value);
      if (!result.lastResponseAt || row.data.time > result.lastResponseAt)
        result.lastResponseAt = row.data.time;
    }
  }
  result.latencies = Object.fromEntries(
    Object.entries(result.latencies).map(([name, values]) => [
      name,
      {
        count: values.length,
        p50Ms: quantile(values, 0.5),
        p95Ms: quantile(values, 0.95),
        maxMs: Math.max(...values),
      },
    ]),
  );
  return result;
}

export function iterationMetrics(summary) {
  return {
    droppedIterations: summary.metrics?.dropped_iterations?.count ?? null,
    cappedIterations: summary.metrics?.buyer_capped_iterations?.count ?? null,
  };
}

export function validity(
  run,
  points,
  evidence,
  apiCount,
  generatorIterations = iterationMetrics({}),
) {
  const traffic = run.snapshot.trafficConfig;
  const planned =
    traffic.mode === "buyer-spike"
      ? traffic.buyerCount
      : traffic.ratePerSecond * traffic.durationSeconds;
  const counters = evidence.counters.map((row) => row.counts);
  const total = (key) => counters.reduce((sum, counter) => sum + counter[key], 0);
  const winners =
    (points.outcomes.reservation_secured ?? 0) +
    (points.outcomes.order_confirmed ?? 0) +
    (points.outcomes.confirmation_failed ?? 0);
  return {
    business: Object.values(evidence.correctness).every(Boolean),
    fullPlannedDelivery: points.started === planned && points.completed === planned,
    noReportedDroppedIterations: !(generatorIterations.droppedIterations > 0),
    attributed: points.invalidAttribution === 0,
    observerComplete:
      counters.length === apiCount &&
      counters.every((c) => c.started > 0) &&
      total("started") === points.started &&
      total("completed") === points.completed,
    observerOutcomes:
      total("accepted") ===
        (points.outcomes.reservation_secured ?? 0) + (points.outcomes.order_confirmed ?? 0) &&
      total("soldOut") === (points.outcomes.sold_out ?? 0) &&
      total("failed") === (points.outcomes.confirmation_failed ?? 0),
    durableAcceptance: evidence.business.orders === winners,
    protocol: Object.keys(points.outcomes).every((outcome) =>
      ["reservation_secured", "order_confirmed", "sold_out", "confirmation_failed"].includes(
        outcome,
      ),
    ),
    cleanResponses:
      !points.outcomes.confirmation_failed && !points.outcomes.transport_or_protocol_failure,
  };
}

export async function collectDrainedEvidence(request, drainDeadline) {
  for (;;) {
    const evidence = await request("/snapshot");
    if (Object.values(evidence.correctness).every(Boolean) || Date.now() > drainDeadline)
      return evidence;
    if (evidence.business.escalated) await request("/reconcile-uncertain", "POST");
    await sleep(1000);
  }
}

export async function runMatrix(plan, directory, env = process.env) {
  if (env.FEASIBILITY_LAB !== "true" || !env.LAB_TOKEN || !env.LAB_CORE_URL || !env.LAB_STORES_URL)
    throw new Error("Run only inside the isolated lab runner.");
  await mkdir(directory, { recursive: true });
  const request = async (path, method = "GET", body) => {
    const response = await fetch(`${env.LAB_CORE_URL}${path}`, {
      method,
      headers: {
        "x-lab-token": env.LAB_TOKEN,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(120_000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  };
  const cells =
    plan.runs ??
    interleave(plan.modes, plan.pairs ?? 6).map((entry) => ({ ...entry, snapshot: plan.snapshot }));
  const records = [];
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    const run = await request("/runs", "POST", { mode: cell.mode, snapshot: cell.snapshot });
    const output = resolve(directory, run.runId);
    await mkdir(output);
    await writeFile(
      resolve(output, "run.json"),
      JSON.stringify(
        {
          cell,
          run,
          runner: {
            cpuCount: (await import("node:os")).cpus().length,
            memoryBytes: (await import("node:os")).totalmem(),
          },
        },
        null,
        2,
      ),
    );
    const rtt = await request("/rtt");
    await writeFile(resolve(output, "rtt.json"), JSON.stringify(rtt));
    let sampling = false;
    const cpu = [];
    const sample = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const storeResponse = await fetch(env.LAB_STORES_URL, {
          headers: { "x-lab-token": env.LAB_TOKEN },
          signal: AbortSignal.timeout(5000),
        });
        if (!storeResponse.ok) throw new Error("Store CPU sampling failed.");
        cpu.push({
          core: await request("/cpu"),
          stores: await storeResponse.json(),
          runner: {
            observedAt: new Date().toISOString(),
            ...(await readCgroupSample()),
          },
        });
      } catch (error) {
        cpu.push({ missing: true, error: error.message, observedAt: new Date().toISOString() });
      } finally {
        sampling = false;
      }
    };
    await sample();
    const sampler = setInterval(() => void sample(), 1000);
    const pointsPath = resolve(output, "k6.json");
    const child = spawn(
      "k6",
      [
        "run",
        "--quiet",
        "--out",
        `json=${pointsPath}`,
        "--summary-export",
        resolve(output, "summary.json"),
        fileURLToPath(new URL("./buyers.js", import.meta.url)),
      ],
      { env: { ...env, LAB_RUN_JSON: JSON.stringify(run) }, stdio: ["ignore", "pipe", "pipe"] },
    );
    const logs = [
      pipeline(child.stdout, createWriteStream(resolve(output, "k6.stdout.txt"))),
      pipeline(child.stderr, createWriteStream(resolve(output, "k6.stderr.txt"))),
    ];
    const k6ExitCode = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    await Promise.all(logs);
    const generatorIterations = iterationMetrics(
      JSON.parse(await readFile(resolve(output, "summary.json"), "utf8")),
    );
    const drainDeadline = Date.now() + 600_000;
    const evidence = await collectDrainedEvidence(request, drainDeadline);
    clearInterval(sampler);
    while (sampling) await sleep(5);
    await sample();
    await writeFile(resolve(output, "cpu.json"), JSON.stringify(cpu));
    await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2));
    await pipeline(
      createReadStream(pointsPath),
      createGzip(),
      createWriteStream(`${pointsPath}.gz`),
    );
    await rm(pointsPath);
    const points = await analyzePoints(`${pointsPath}.gz`, run);
    const valid = validity(
      run,
      points,
      evidence,
      Number(env.LAB_API_COUNT ?? 3),
      generatorIterations,
    );
    valid.k6Succeeded = k6ExitCode === 0;
    valid.cpuObserved =
      cpu.length >= 2 &&
      cpu.every((point) => !point.missing && point.stores.cpu.postgres && point.stores.cpu.redis);
    const record = {
      runId: run.runId,
      mode: run.mode,
      pair: cell.pair ?? null,
      warmup: cell.warmup === true,
      points,
      valid,
      evidence,
      rtt,
      k6ExitCode,
      generatorIterations,
    };
    await writeFile(resolve(output, "record.json"), JSON.stringify(record, null, 2));
    records.push(record);
    const files = [
      "run.json",
      "rtt.json",
      "cpu.json",
      "evidence.json",
      "k6.json.gz",
      "summary.json",
      "k6.stdout.txt",
      "k6.stderr.txt",
      "record.json",
    ];
    const checksums = {};
    for (const file of files)
      checksums[file] = createHash("sha256")
        .update(await readFile(resolve(output, file)))
        .digest("hex");
    await writeFile(
      resolve(output, "complete.json"),
      JSON.stringify({ runId: run.runId, files: checksums }),
    );
    await request("/finish", "POST", {
      reset: !Object.values(evidence.correctness).every(Boolean),
    });
    console.log(
      JSON.stringify({
        runId: run.runId,
        mode: run.mode,
        pair: record.pair,
        requests: points.completed,
        plannedDelivered: valid.fullPlannedDelivery,
        correct: valid.business,
        clean: valid.cleanResponses,
      }),
    );
  }
  await writeFile(resolve(directory, "records.json"), JSON.stringify(records, null, 2));
  console.log(`FEASIBILITY_MATRIX_COMPLETE ${records.length}`);
  return records;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
  await runMatrix(plan, resolve(process.argv[3] ?? "/results/feasibility"));
}
