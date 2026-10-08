#!/usr/bin/env node
// Capacity measurement: starts admin runs from a run list, waits for each to end, appends the
// evidence the run persisted to a JSON Lines file, then tears the run down. Node builtins only,
// so it also runs inside the hosted API container, where CONTROL_SERVICE_TOKEN is already set.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const pollIntervalMs = 5_000;
// The API resets a run that is still nonterminal 900 s after its acceptance.
const runDeadlineMs = 960_000;
const requestTimeoutMs = 30_000;
// A start answers once the runner has booted and k6 has started.
const startTimeoutMs = 180_000;
const teardownTimeoutMs = 120_000;
const teardownDeadlineMs = 60_000;

function required(run, name) {
  if (run[name] === undefined) throw new Error(`Run "${run.label}": ${name} is required.`);
  return run[name];
}

/** Maps one run-list entry to an admin start request on the custom preset. */
export function toStartRequest(run) {
  const value = (name) => required(run, name);
  value("label");
  let trafficConfig;
  if (run.mode === "constant-arrival-rate") {
    trafficConfig = {
      mode: run.mode,
      ratePerSecond: value("ratePerSecond"),
      durationSeconds: value("durationSeconds"),
      startDelaySeconds: value("startDelaySeconds"),
      // Explicit VUs, so the default derivation never shapes a measurement.
      k6Vus: { preAllocatedVus: value("preAllocatedVus"), maxVus: value("maxVus") },
    };
  } else if (run.mode === "buyer-spike") {
    trafficConfig = {
      mode: run.mode,
      buyerCount: value("buyerCount"),
      maxDurationSeconds: value("maxDurationSeconds"),
      startDelaySeconds: value("startDelaySeconds"),
    };
  } else {
    throw new Error(`Run "${run.label}": mode must be constant-arrival-rate or buyer-spike.`);
  }
  return {
    presetSlug: "custom",
    configOverride: {
      trafficConfig,
      inventoryConfig: { startingStock: value("startingStock") },
      erpConfig: {
        latencyMs: value("erpLatencyMs"),
        maxTps: value("erpMaxTps"),
        errorRate: value("erpErrorRate"),
      },
      backpressureConfig: {
        queueName: "orders:process",
        physicalQueueName: "orders-process",
        orderProcessConcurrency: value("orderProcessConcurrency"),
      },
    },
  };
}

/** One JSON record per run: the evidence the run persisted, read from its admin detail. */
function toRecord({ label, detail, estimate, host }) {
  const { run, summary } = detail;
  const delivery = summary.trafficDeliverySummary;
  const diagnostics = detail.loadRunDiagnosticsSummary;
  return {
    label,
    runId: run.runId,
    host,
    config: run.configSnapshot,
    conservativeEstimateSeconds: estimate.conservativeDurationSeconds,
    status: run.status,
    deliveryStatus: delivery.trafficDeliveryStatus,
    failureReason: detail.internalFailureReason ?? null,
    failureDiagnostic: detail.failureDiagnostic,
    times: {
      startedAt: run.startedAt,
      trafficStartedAt: run.trafficStartedAt ?? null,
      trafficEndedAt: run.trafficEndedAt ?? null,
      finalizedAt: run.finalizedAt,
      overallDurationMs: detail.overallDurationMs,
    },
    requests: summary.transportAttemptCounts,
    droppedIterations: delivery.droppedIterations,
    completedIterations: delivery.completedIterations,
    responses: summary.httpSummary,
    httpTimings: detail.httpTimingBreakdownSummary,
    serverReservationTiming: summary.serverReservationTimingSummary,
    arrival: delivery.requestArrivalSummary,
    vus: {
      preAllocated: delivery.preAllocatedVUs,
      max: delivery.maxVUs,
      insufficientVuWarnings:
        diagnostics?.stderrLines.filter((line) => line.includes("Insufficient VUs")).length ?? null,
    },
    generator: diagnostics && {
      nproc: diagnostics.nproc,
      capacity: diagnostics.generatorCapacity,
      utilisation: diagnostics.generatorUtilisation,
      k6StartedAt: diagnostics.startedAt,
      k6CompletedAt: diagnostics.completedAt,
    },
    business: summary.businessOutcomeSummary,
  };
}

function summaryLine(record) {
  const seconds = (ms) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(2)} s`);
  const { requests, responses } = record;
  return [
    record.label,
    `${record.status}/${record.deliveryStatus}${record.failureReason ? ` (${record.failureReason})` : ""}`,
    // Completion is judged from these counts: every planned request completed, none failed.
    // A completed request can still have failed (a transport failure or an unexpected response).
    `completed ${requests.completedRequests}/${requests.plannedRequests} (interrupted ${requests.interruptedRequests}, unstarted ${requests.unstartedRequests})`,
    `failed ${responses.failedRequests}`,
    `dropped ${record.droppedIterations}`,
    `accepted ${responses.acceptedResponses}`,
    `sold out ${responses.soldOutResponses}`,
    `p95 ${seconds(responses.p95LatencyMs)}`,
    `waiting avg ${seconds(record.httpTimings.waiting?.averageMs)}`,
    `peak arrival ${record.arrival.peakArrivalRatePerSecond}/s`,
  ].join(" | ");
}

function describe({ status, payload }) {
  const details = payload?.details ? ` ${JSON.stringify(payload.details)}` : "";
  return `HTTP ${status} ${payload?.code ?? ""} ${payload?.message ?? ""}${details}`.trim();
}

function apiClient(baseUrl, token) {
  return async (method, path, body, timeoutMs = requestTimeoutMs) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "x-control-service-token": token,
        "x-demo-operator-mode": "admin",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  };
}

async function startRun(api, request, label) {
  const deadline = Date.now() + runDeadlineMs;
  let waiting = false;
  for (;;) {
    const response = await api("POST", "/demo/runs/start", request, startTimeoutMs);
    if (response.status === 202) return response.payload.run.runId;
    const slotTaken = response.payload?.details?.conflictReason === "active_run_exists";
    if (!slotTaken || Date.now() > deadline)
      throw new Error(`Run "${label}" was not started: ${describe(response)}`);
    if (!waiting) console.log(`${label}: another run holds the slot; waiting for it to end`);
    waiting = true;
    await delay(pollIntervalMs);
  }
}

// The admin detail exists once the run is terminal; until then it answers 404.
async function waitForTerminalDetail(api, runId) {
  const deadline = Date.now() + runDeadlineMs;
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    // A poll can time out while the API is saturated; the next one retries.
    const response = await api("GET", `/admin/demo/runs/history/${runId}`).catch(() => null);
    if (response?.status === 200) return response.payload;
    if (response && response.status !== 404)
      throw new Error(`Run ${runId} detail: ${describe(response)}`);
  }
  throw new Error(`Run ${runId} did not end within ${runDeadlineMs / 1000} s.`);
}

// Deletes the run's data (PostgreSQL rows and Redis keys, completed queue jobs included),
// so every run starts from the same state and the stores do not grow across a series.
async function teardownRun(api, runId) {
  const deadline = Date.now() + teardownDeadlineMs;
  for (;;) {
    let response;
    try {
      response = await api("DELETE", `/admin/demo/runs/${runId}`, null, teardownTimeoutMs);
    } catch (error) {
      return `failed: ${error.message}`;
    }
    if (response.status === 200) return response.payload.outcome;
    const activeJobs = response.payload?.details?.conflictReason === "active_job";
    if (!activeJobs || Date.now() > deadline) return `failed: ${describe(response)}`;
    await delay(1_000);
  }
}

async function main([runListFile, outputFile]) {
  if (!runListFile || !outputFile)
    throw new Error("Usage: node capacity-measurement.mjs <run-list.json> <results.jsonl>");
  const token = process.env.CONTROL_SERVICE_TOKEN?.trim();
  if (!token) throw new Error("CONTROL_SERVICE_TOKEN is not set.");
  // fetch would otherwise reject the header with a message that contains the token.
  try {
    new Headers({ "x-control-service-token": token });
  } catch {
    throw new Error("CONTROL_SERVICE_TOKEN is not a valid HTTP header value.");
  }
  const api = apiClient(process.env.API_BASE_URL ?? "http://127.0.0.1:4000", token);
  const runs = JSON.parse(readFileSync(runListFile, "utf8"));
  if (!Array.isArray(runs)) throw new Error("The run list must be a JSON array.");
  const requests = runs.map(toStartRequest);

  // Preflight: the API validates every run and estimates it before anything starts.
  const estimates = [];
  for (const [index, request] of requests.entries()) {
    const response = await api("POST", "/demo/runs/estimate", request);
    const result = response.status === 200 ? response.payload.result : null;
    if (result?.decision !== "admitted")
      throw new Error(
        `Run "${runs[index].label}" is not admitted: ${result?.reasons?.join(" ") ?? describe(response)}`,
      );
    estimates.push(result);
  }

  const host = {
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? null,
    memTotalBytes: totalmem(),
  };
  mkdirSync(dirname(resolve(outputFile)), { recursive: true });
  for (const [index, run] of runs.entries()) {
    const runId = await startRun(api, requests[index], run.label);
    console.log(`${run.label}: run ${runId} started`);
    const detail = await waitForTerminalDetail(api, runId);
    const record = toRecord({ label: run.label, detail, estimate: estimates[index], host });
    appendFileSync(outputFile, `${JSON.stringify(record)}\n`);
    const teardown = await teardownRun(api, runId);
    console.log(`${summaryLine(record)} | teardown ${teardown}`);
    // A run left in place would change the state the next run starts from.
    if (teardown.startsWith("failed")) throw new Error(`Run ${runId} was not torn down.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
