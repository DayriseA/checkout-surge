import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

// Offline only: three APIs, six core CPUs, two shared store CPUs, runner allocation from run.json.
// node scripts/feasibility/analyze-results.mjs <root> <windowStartSec> <windowEndSec> [observedTickHz] [classification]
const [input, fromText, toText, hzText, classification = "unclassified"] = process.argv.slice(2);
const root = resolve(input);
const from = Number(fromText),
  to = Number(toText),
  tickHz = hzText ? Number(hzText) : null;
if (!(from >= 0 && to > from) || (tickHz !== null && !(tickHz > 0)))
  throw new Error("Supply a common window and, optionally, observed CLK_TCK.");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const records = await json(join(root, "records.json"));
const round = (n) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);
const instantNs = (text) => {
  const normalized = text.replace(" ", "T").replace(/\+00$/, "Z");
  const match = normalized.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/);
  if (!match) throw new Error(`Unsupported timestamp: ${text}`);
  return BigInt(Date.parse(`${match[1]}Z`)) * 1_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
};
const distribution = (values) => {
  if (!values.length) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  values.sort((a, b) => a - b);
  return {
    count: values.length,
    p50Ms: round(values[Math.ceil(values.length * 0.5) - 1]),
    p95Ms: round(values[Math.ceil(values.length * 0.95) - 1]),
    maxMs: round(values.at(-1)),
  };
};
const interpolate = (series, t) => {
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1],
      b = series[i];
    if (a.t <= t && t <= b.t && b.t > a.t) return a.u + ((b.u - a.u) * (t - a.t)) / (b.t - a.t);
  }
  return null;
};
const cpuWindow = (series, low, high) => {
  if (!(high > low)) return { covered: false, meanCores: null };
  const a = interpolate(series, low),
    b = interpolate(series, high);
  return {
    covered: a !== null && b !== null,
    meanCores: a === null || b === null ? null : round((b - a) / 1000 / (high - low)),
  };
};
const cpuSeries = (samples, role) =>
  samples
    .filter((s) => !s.missing)
    .map((s) =>
      role === "postgres" || role === "redis"
        ? {
            t: s.stores.cpu[role]?.epochSeconds * 1000,
            u: s.stores.cpu[role]?.usageUsec,
            memory: s.stores.cpu[role]?.memoryBytes,
          }
        : { t: Date.parse(s[role].observedAt), u: s[role].usageUsec, memory: s[role].memoryBytes },
    );
const cpuStats = (series, low, high, drainLow, drainHigh, budget) => {
  let peak = null,
    peakInside = null,
    insideIntervals = 0,
    monotonic = true,
    finite = true;
  for (let i = 0; i < series.length; i++) {
    const b = series[i];
    if (![b.t, b.u].every(Number.isFinite)) finite = false;
    if (!i) continue;
    const a = series[i - 1],
      dt = b.t - a.t,
      du = b.u - a.u;
    if (dt < 0 || du < 0 || (dt === 0 && du !== 0)) monotonic = false;
    if (dt > 0) {
      const cores = du / 1000 / dt;
      peak = Math.max(peak ?? 0, cores);
      if (a.t >= low && b.t <= high) {
        peakInside = Math.max(peakInside ?? 0, cores);
        insideIntervals++;
      }
    }
  }
  const memory = series.map((s) => s.memory).filter(Number.isFinite);
  return {
    ...cpuWindow(series, low, high),
    finite,
    monotonic,
    sampledPeakCores: round(peak),
    sampledPeakFractionOfAllocation: budget && peak !== null ? round(peak / budget) : null,
    sampledPeakCoresInsideWindow: round(peakInside),
    sampledPeakFractionInsideWindow:
      budget && peakInside !== null ? round(peakInside / budget) : null,
    insideWindowIntervalCount: insideIntervals,
    maxMemoryMiB: memory.length ? round(Math.max(...memory) / 2 ** 20) : null,
    postBuyerDrain: cpuWindow(series, drainLow, drainHigh),
  };
};

for (const record of records) {
  const folder = join(root, record.runId),
    runFile = await json(join(folder, "run.json"));
  const run = runFile.run,
    evidence = await json(join(folder, "evidence.json"));
  const budgets = {
    core: 6,
    runner: [8, 16].includes(runFile.runner?.cpuCount) ? runFile.runner.cpuCount : null,
    postgres: 2,
    redis: 2,
  };
  const summary = await json(join(folder, "summary.json")),
    manifest = await json(join(folder, "complete.json"));
  const expectedFiles = [
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
  const hashFailures = [];
  for (const file of expectedFiles) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(folder, file))) hash.update(chunk);
    if (hash.digest("hex") !== manifest.files[file]) hashFailures.push(file);
  }
  const starts = new Map(),
    ends = new Map(),
    outcomes = {},
    statuses = {};
  let started = 0,
    completed = 0,
    duplicate = 0,
    invalidAttribution = 0,
    invalidStartValue = 0;
  let rawDropped = null,
    rawCapped = null;
  const reader = createInterface({
    input: createReadStream(join(folder, "k6.json.gz")).pipe(createGunzip()),
  });
  for await (const line of reader) {
    const point = JSON.parse(line);
    if (point.type !== "Point") continue;
    if (point.metric === "dropped_iterations") {
      rawDropped = (rawDropped ?? 0) + point.data.value;
      continue;
    }
    if (point.metric === "buyer_capped_iterations") {
      rawCapped = (rawCapped ?? 0) + point.data.value;
      if (point.data.tags.runId !== run.runId || point.data.tags.mode !== run.mode)
        invalidAttribution++;
      continue;
    }
    if (!["buyer_started", "buyer_result"].includes(point.metric)) continue;
    const tags = point.data.tags,
      target = point.metric === "buyer_started" ? starts : ends;
    if (tags.runId !== run.runId || tags.mode !== run.mode || !tags.attempt) invalidAttribution++;
    if (target.has(tags.attempt)) duplicate++;
    target.set(tags.attempt, {
      ns: instantNs(point.data.time),
      outcome: tags.outcome,
      status: tags.status,
      httpMs: point.data.value,
    });
    if (point.metric === "buyer_started") {
      started += point.data.value;
      if (point.data.value !== 1) invalidStartValue++;
    } else {
      completed++;
      outcomes[tags.outcome] = (outcomes[tags.outcome] ?? 0) + 1;
      statuses[tags.status] = (statuses[tags.status] ?? 0) + 1;
    }
  }
  const wall = { all: [], winners: [], soldOut: [] },
    http = { winners: [], soldOut: [] },
    wallByOutcome = {};
  let unmatched = 0,
    negativeWall = 0,
    invalidStatus = 0,
    firstNs = null,
    lastStartedNs = null,
    lastResponseNs = null;
  for (const start of starts.values()) {
    if (firstNs === null || start.ns < firstNs) firstNs = start.ns;
    if (lastStartedNs === null || start.ns > lastStartedNs) lastStartedNs = start.ns;
  }
  for (const [attempt, end] of ends) {
    if (lastResponseNs === null || end.ns > lastResponseNs) lastResponseNs = end.ns;
    const expectedStatus =
      end.outcome === "reservation_secured" && run.mode !== "no-queue"
        ? "202"
        : end.outcome === "order_confirmed" && run.mode === "no-queue"
          ? "200"
          : end.outcome === "sold_out"
            ? "409"
            : ["confirmation_failed", "confirmation_unresolved"].includes(end.outcome) &&
                run.mode === "no-queue"
              ? "504"
              : null;
    if (end.status !== expectedStatus) invalidStatus++;
    const start = starts.get(attempt);
    if (!start) {
      unmatched++;
      continue;
    }
    const ms = Number(end.ns - start.ns) / 1e6;
    if (ms < 0) negativeWall++;
    wall.all.push(ms);
    wallByOutcome[end.outcome] ??= [];
    wallByOutcome[end.outcome].push(ms);
    if (["reservation_secured", "order_confirmed"].includes(end.outcome)) {
      wall.winners.push(ms);
      http.winners.push(end.httpMs);
    }
    if (end.outcome === "sold_out") {
      wall.soldOut.push(ms);
      http.soldOut.push(end.httpMs);
    }
  }
  const traffic = run.snapshot.trafficConfig;
  const planned =
    traffic.mode === "buyer-spike"
      ? traffic.buyerCount
      : traffic.ratePerSecond * traffic.durationSeconds;
  const unstarted = Math.max(0, planned - started),
    excess = Math.max(0, started - planned);
  const totals = evidence.counters.reduce((out, row) => {
    for (const [key, value] of Object.entries(row.counts)) out[key] = (out[key] ?? 0) + value;
    return out;
  }, {});
  const won = (outcomes.reservation_secured ?? 0) + (outcomes.order_confirmed ?? 0);
  const failedWinners = outcomes.confirmation_failed ?? 0;
  const summaryDropped =
    summary.metrics.dropped_iterations?.count ??
    summary.metrics.dropped_iterations?.values?.count ??
    null;
  const summaryCapped =
    summary.metrics.buyer_capped_iterations?.count ??
    summary.metrics.buyer_capped_iterations?.values?.count ??
    null;
  const gates = {
    runAgreement:
      record.runId === run.runId &&
      record.mode === run.mode &&
      evidence.run.runId === run.runId &&
      evidence.run.mode === run.mode,
    hashes:
      hashFailures.length === 0 &&
      manifest.runId === run.runId &&
      Object.keys(manifest.files).length === expectedFiles.length,
    attributionAndStatus: invalidAttribution === 0 && invalidStatus === 0,
    uniqueAttempts:
      duplicate === 0 &&
      invalidStartValue === 0 &&
      unmatched === 0 &&
      negativeWall === 0 &&
      ends.size <= starts.size,
    fullPlannedDelivery:
      started === planned &&
      completed === planned &&
      starts.size === planned &&
      ends.size === planned,
    observerAccounting:
      evidence.counters.length === 3 &&
      totals.started === started &&
      totals.completed === completed &&
      totals.accepted === won &&
      totals.soldOut === (outcomes.sold_out ?? 0) &&
      totals.failed === failedWinners,
    durableAcceptance: evidence.business.orders === won + failedWinners,
    business: Object.values(evidence.correctness).every((v) => v === true),
    cleanResponses: Object.keys(outcomes).every((key) =>
      ["sold_out", "reservation_secured", "order_confirmed"].includes(key),
    ),
    k6Succeeded: record.k6ExitCode === 0,
    droppedConsistent:
      (rawDropped === null || rawDropped === unstarted) &&
      (summaryDropped === null || summaryDropped === unstarted),
    noReportedDroppedIterations:
      (rawDropped === null || rawDropped === 0) &&
      (summaryDropped === null || summaryDropped === 0),
    cappedConsistent: rawCapped === null || summaryCapped === null || rawCapped === summaryCapped,
  };
  const t0 = firstNs === null ? NaN : Number(firstNs) / 1e6;
  const arrivalBins = {};
  if (firstNs !== null)
    for (const start of starts.values()) {
      const second = Number((start.ns - firstNs) / 1_000_000_000n);
      arrivalBins[second] = (arrivalBins[second] ?? 0) + 1;
    }
  const lastResponse = lastResponseNs === null ? NaN : Number(lastResponseNs) / 1e6;
  const confirmed = evidence.business.lastConfirmedAt
    ? Number(instantNs(evidence.business.lastConfirmedAt)) / 1e6
    : NaN;
  const samples = await json(join(folder, "cpu.json")),
    cpu = {};
  for (const role of Object.keys(budgets))
    cpu[role] = cpuStats(
      cpuSeries(samples, role),
      t0 + from * 1000,
      t0 + to * 1000,
      lastResponse,
      confirmed,
      budgets[role],
    );
  const apis = [];
  for (let index = 0; index < 3; index++) {
    const processSamples = samples
      .filter((s) => !s.missing)
      .map((s) => ({ t: Date.parse(s.core.observedAt), process: s.core.processes[index + 3] }));
    const pids = new Set(processSamples.map((s) => s.process?.pid));
    const series = processSamples.map((s) => ({
      t: s.t,
      u: s.process && tickHz ? ((s.process.userTicks + s.process.systemTicks) * 1e6) / tickHz : NaN,
      memory: null,
    }));
    apis.push({
      api: index,
      stablePid: pids.size === 1 && !pids.has(undefined),
      maxRssPages: Math.max(...processSamples.map((s) => s.process?.rssPages ?? NaN)),
      ...cpuStats(series, t0 + from * 1000, t0 + to * 1000, lastResponse, confirmed, null),
    });
  }
  const storeAgeSec = samples
    .filter((s) => !s.missing)
    .flatMap((s) =>
      ["postgres", "redis"].map(
        (role) => Date.parse(s.stores.observedAt) / 1000 - s.stores.cpu[role]?.epochSeconds,
      ),
    );
  const completeCapturePath = join(root, "matrix.stdout.txt");
  const completeCapture = existsSync(completeCapturePath)
    ? new RegExp(`^FEASIBILITY_MATRIX_COMPLETE ${records.length}\\s*$`, "m").test(
        await readFile(completeCapturePath, "utf8"),
      )
    : null;
  console.log(
    JSON.stringify({
      root,
      runId: run.runId,
      mode: run.mode,
      pair: record.pair,
      warmup: record.warmup,
      classification,
      raw: {
        points: join(folder, "k6.json.gz"),
        manifest: join(folder, "complete.json"),
        hashFailures,
        plan: existsSync(join(root, "plan.json")) ? join(root, "plan.json") : null,
        completionCapture: completeCapture,
      },
      counts: {
        planned,
        started,
        completed,
        interrupted: Math.max(0, started - completed),
        unstarted,
        excess,
        rawDropped,
        summaryDropped,
        rawCapped,
        summaryCapped,
        transportFailures: statuses["0"] ?? 0,
        confirmationFailed: outcomes.confirmation_failed ?? 0,
        confirmationUnresolved: outcomes.confirmation_unresolved ?? 0,
        outcomes,
        statuses,
        startsBySecondAfterFirstStart: arrivalBins,
      },
      gates,
      mismatches: { invalidAttribution, invalidStatus, duplicate, unmatched, negativeWall },
      observerTotals: totals,
      business: evidence.business,
      wallMs: Object.fromEntries(
        Object.entries(wall).map(([key, value]) => [key, distribution(value)]),
      ),
      wallByOutcomeMs: Object.fromEntries(
        Object.entries(wallByOutcome).map(([key, value]) => [key, distribution(value)]),
      ),
      httpMs: Object.fromEntries(
        Object.entries(http).map(([key, value]) => [key, distribution(value)]),
      ),
      timingSec: {
        dispatchSpan: firstNs === null ? null : round(Number(lastStartedNs - firstNs) / 1e9),
        buyerServeSpan:
          firstNs === null || lastResponseNs === null
            ? null
            : round(Number(lastResponseNs - firstNs) / 1e9),
        lastConfirmationAfterFirstBuyer: round((confirmed - t0) / 1000),
        postBuyerConfirmation: round(Math.max(0, confirmed - lastResponse) / 1000),
      },
      cpu: {
        commonWindowSec: [from, to],
        scope:
          "core=lab container excluding Caddy; PG/Redis=separate containers sharing two Machine CPUs; runner=matrix+k6 cgroup; peaks cover all observed samples, including initialization and drain",
        allocationCores: budgets,
        allocationProvenance: `Core/stores: fixed lab topology; runner: ${join(folder, "run.json")} runner.cpuCount (8 or 16 only; missing/unsupported stays null). Verify actual Machine metadata before interpreting headroom`,
        runnerMemoryBytes: runFile.runner?.memoryBytes ?? null,
        runnerMemoryProvenance: `${join(folder, "run.json")} runner.memoryBytes`,
        tickHzInput: tickHz,
        tickHzProvenance: "CLI input; confirm getconf CLK_TCK before interpreting per-process CPU",
        sampleCount: samples.length,
        missingSamples: samples.filter((s) => s.missing).length,
        maxStoreSnapshotAgeSec: round(Math.max(...storeAgeSec)),
        uncertainty:
          "Linear interpolation only between real brackets; store epochs are integer seconds and sampling is asynchronous, approximately one-second boundary uncertainty",
        commonWindowCovered: Object.values(cpu).every((s) => s.covered && s.finite && s.monotonic),
        roles: cpu,
        apis,
      },
    }),
  );
}
