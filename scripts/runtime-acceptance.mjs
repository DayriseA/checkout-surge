#!/usr/bin/env node
// Explicit, destructive verification of the selected disposable Compose runtime.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  adminRunHistoryDetailPath,
  adminRunHistoryDetailResponseSchema,
  erpDispatchRateLimit,
  idleErpDispatchLimits,
  startDemoRunResponseSchema,
  uuidSchema,
} from "../packages/contracts/dist/index.js";
import { acceptanceScenarioFixtures } from "../packages/contracts/dist/testing.js";
import { prepareExactRunCleanup, teardownWithRetry } from "./runtime-smoke.mjs";

const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });

export function assertAcceptance(summary, durable, expected) {
  const business = summary.businessOutcomeSummary;
  for (const [key, value] of Object.entries({
    acceptedReservations: expected.acceptedReservations,
    soldOutRejections: expected.soldOutResponses,
    confirmedOrders: expected.confirmedOrders,
    notificationsRecorded: expected.notificationsRecorded,
    failedOrders: expected.terminalOrderFailures,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    pendingPersistenceCount: 0,
  }))
    assert.equal(business[key], value, key);
  for (const key of ["plannedRequests", "startedRequests", "completedRequests"])
    assert.equal(summary.transportAttemptCounts[key], expected.plannedEmittedAttempts, key);
  for (const key of ["interruptedRequests", "unstartedRequests"])
    assert.equal(summary.transportAttemptCounts[key], 0, key);
  assert.equal(
    summary.httpSummary.acceptedResponses,
    expected.acceptedReservations + expected.duplicateReplayResponses,
    "accepted HTTP responses",
  );
  assert.equal(
    summary.httpSummary.soldOutResponses,
    expected.soldOutResponses,
    "sold-out HTTP responses",
  );
  assert.equal(summary.httpSummary.transportFailures, 0, "transport failures");
  assert.equal(summary.httpSummary.unexpectedResponses, 0, "unexpected responses");
  assert.equal(summary.trafficDeliverySummary.droppedIterations, 0, "dropped iterations");
  assert.equal(durable.reservations, expected.acceptedReservations, "durable reservations");
  assert.equal(durable.confirmed, expected.confirmedOrders, "durable confirmed");
  assert.equal(durable.ledger, expected.confirmedOrders, "canonical external effects");
  assert.equal(durable.notifications, expected.notificationsRecorded, "durable notifications");
  assert.equal(durable.outstanding, 0, "outstanding orders");
  assert.equal(durable.unresolved, 0, "unresolved calls");
  assert.equal(summary.terminalInventorySnapshot.reservedStock, expected.reservedUnits);
  assert.equal(
    summary.terminalInventorySnapshot.remainingStock,
    summary.terminalInventorySnapshot.startingStock - expected.reservedUnits,
    "remaining stock",
  );
}

export function assertOutageEvidence(report) {
  assert(report.outage?.restoredAt, "A real finite outage must have completed");
  const isUnavailable = (event) =>
    ["temporarily_unavailable", "uncertain_result"].includes(event.disposition);
  const firstFailure = report.workerHttp.events.find(
    (event) => isUnavailable(event) && event.time >= Date.parse(report.outage.stopRequestedAt),
  );
  assert(firstFailure, "The worker must observe the actual outage");
  assert(report.outage.circuitOpenObservedAt, "Durable availability circuit must actually open");
  const probes = report.workerHttp.events.filter(
    (event) =>
      isUnavailable(event) &&
      event.time > Date.parse(report.outage.circuitOpenObservedAt) &&
      event.time < Date.parse(report.outage.startRequestedAt),
  );
  const firstRecoveryRpc = report.erpHttp.events.find(
    (event) => event.method && event.time >= Date.parse(report.outage.startRequestedAt),
  );
  assert(firstRecoveryRpc, "Actual ERP delivery or lookup must resume after service restart");
  report.outage.probeEvidence = {
    definition:
      "Actual failed POST/GET completion observations after durable circuit opening was observed (1s polling), before container start. Non-call deferrals and initial detection failures excluded; completion timestamps, not packet captures. Zero probes is valid when durable backoff extends past the outage.",
    firstFailureAt: new Date(firstFailure.time).toISOString(),
    events: probes,
    firstRecoveryRpc,
  };
  for (let index = 1; index < probes.length; index++)
    assert(
      probes[index].time - probes[index - 1].time >= 5000,
      "Outage probes must be at least five seconds apart",
    );
}

function serviceAddress(service, port) {
  const id = docker("compose", "ps", "-q", service).trim();
  assert(id, `Missing running service: ${service}`);
  const [container] = JSON.parse(docker("inspect", id));
  const network = Object.entries(container.NetworkSettings.Networks).find(([name]) =>
    name.endsWith("_default"),
  );
  assert(network, "Linux verification requires the Compose default bridge network");
  return {
    url: `http://${network[1].IPAddress}:${port}`,
    id,
    image: container.Image,
    project: container.Config.Labels["com.docker.compose.project"],
  };
}

export function durableEvidence(runId) {
  uuidSchema.parse(runId);
  const query = `SELECT json_build_object(
    'reservations',(SELECT count(*) FROM reservations WHERE run_id='${runId}'),
    'confirmed',(SELECT count(*) FROM orders WHERE run_id='${runId}' AND status='confirmed'),
    'outstanding',(SELECT count(*) FROM orders WHERE run_id='${runId}' AND status NOT IN ('confirmed','failed')),
    'ledger',(SELECT count(*) FROM erp_confirmation_ledger WHERE run_id='${runId}'),
    'notifications',(SELECT count(*) FROM simulated_notifications WHERE run_id='${runId}'),
    'unresolved',(SELECT count(*) FROM erp_dispatch_calls WHERE run_id='${runId}' AND resolved_at IS NULL),
    'lastNotificationAt',(SELECT max(recorded_at) FROM simulated_notifications WHERE run_id='${runId}'),
    'finalizedAt',(SELECT finalized_at FROM demo_runs WHERE id='${runId}'),
    'acceptedUnresolved',(SELECT count(*) FROM erp_dispatch_calls c
      JOIN erp_confirmation_ledger l ON l.idempotency_key=c.idempotency_key
      WHERE c.run_id='${runId}' AND c.resolved_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM erp_attempts a WHERE a.erp_call_id=c.id AND a.status='succeeded')),
    'calls',(SELECT coalesce(json_agg(t ORDER BY t.dispatched_at),'[]'::json) FROM
      (SELECT dispatched_at,resolved_at FROM erp_dispatch_calls WHERE run_id='${runId}') t),
    'attempts',(SELECT coalesce(json_agg(t ORDER BY t.started_at),'[]'::json) FROM
      (SELECT started_at,finished_at,status,http_status,error_code FROM erp_attempts WHERE run_id='${runId}') t),
    'orderTimings',(SELECT coalesce(json_agg(json_build_array(
        extract(epoch FROM processing_at)*1000,
        extract(epoch FROM coalesce(confirmed_at,failed_at))*1000)),'[]'::json)
      FROM orders WHERE run_id='${runId}' AND processing_at IS NOT NULL)
  )`;
  return JSON.parse(
    docker(
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "checkout_surge",
      "-At",
      "-c",
      query,
    ),
  );
}

function readProtectionState(runId) {
  uuidSchema.parse(runId);
  const value = docker(
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "checkout_surge",
    "-At",
    "-c",
    `SELECT row_to_json(s) FROM erp_scope_resilience_state s WHERE scope='run:${runId}'`,
  ).trim();
  return value ? JSON.parse(value) : null;
}

function assertQueueLimits(actual, limits) {
  const rate = erpDispatchRateLimit(limits.maxTps);
  for (const [key, value] of Object.entries({ ...rate, concurrency: limits.concurrency }))
    assert.equal(Number(actual[key]), value, `native queue ${key}`);
}

function stableWindow(durable, http) {
  const first = http.events.find((event) => event.method === "POST");
  if (!first) return null;
  const start = first.time + 10_000;
  const end = start + 60_000;
  const inWindow = (time) => time >= start && time < end;
  const confirmations = durable.attempts.filter(
    (attempt) => attempt.status === "succeeded" && inWindow(Date.parse(attempt.finished_at)),
  ).length;
  const posts = http.events.filter(
    (event) => event.method === "POST" && inWindow(event.time),
  ).length;
  const capacity = http.events.filter(
    (event) => event.httpStatus === 429 && inWindow(event.time),
  ).length;
  return {
    definition:
      "First observed POST + 10s, half-open 60s window; descriptive, not a calibration input. Short runs do not cover the window.",
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    covered: durable.attempts.some((attempt) => Date.parse(attempt.finished_at) >= end),
    confirmations,
    confirmationsPerSecond: confirmations / 60,
    posts,
    capacityResponses: capacity,
    capacityResponseShare: posts ? capacity / posts : null,
  };
}

// Calibration evidence; descriptive, never asserted. Job timings come from PostgreSQL order
// timestamps, because finalization removes the run's completed jobs from Redis.
export function calibrationEvidence(durable, declaredLatencyMs) {
  const durations = durable.orderTimings
    .filter(([start, end]) => start && end)
    .map(([start, end]) => end - start);
  const meanMs = durations.length
    ? durations.reduce((sum, value) => sum + value, 0) / durations.length
    : null;
  return {
    definition:
      "Order job service time (orders.processing_at to confirmed_at or failed_at), finalization delay after the last notification, and ERP attempts beyond one per confirmed order.",
    jobs: durations.length,
    meanJobMs: meanMs,
    maxJobMs: durations.length ? Math.max(...durations) : null,
    meanJobOverheadMs: meanMs === null ? null : meanMs - declaredLatencyMs,
    settlementDelaySeconds:
      durable.lastNotificationAt && durable.finalizedAt
        ? (Date.parse(durable.finalizedAt) - Date.parse(durable.lastNotificationAt)) / 1000
        : null,
    excessAttempts: durable.attempts.length - durable.confirmed,
  };
}

function queueLimits() {
  return JSON.parse(
    docker(
      "compose",
      "exec",
      "-T",
      "redis",
      "redis-cli",
      "--json",
      "HGETALL",
      "bull:orders-process:meta",
    ),
  );
}

export function summarizeErpHttp(events) {
  const requests = events.filter(
    (entry) => entry.msg === "incoming request" && entry.req?.url.startsWith("/confirmations"),
  );
  const completions = events.filter(
    (entry) => entry.msg === "Mock ERP confirmation request completed.",
  );
  let inFlight = 0;
  let maximumInFlight = 0;
  for (const entry of events) {
    if (
      entry.msg === "incoming request" &&
      entry.req?.method === "POST" &&
      entry.req.url === "/confirmations"
    )
      inFlight++;
    if (entry.msg === "Mock ERP confirmation request completed.") inFlight--;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
  }
  return {
    posts: requests.filter((entry) => entry.req.method === "POST").length,
    lookups: requests.filter((entry) => entry.req.method === "GET").length,
    capacityResponses: completions.filter((entry) => entry.httpStatus === 429).length,
    maximumInFlight,
    unmatchedRequests: inFlight,
    // Replay headers are not logged; never infer replay counts from successful responses.
    replayResponses: null,
    events: events.map(({ time, msg, req, httpStatus, lookupStatus }) => ({
      time,
      msg,
      ...(req ? { method: req.method, path: req.url } : {}),
      httpStatus,
      lookupStatus,
    })),
  };
}

export function readErpHttpEvidence(correlationId, since) {
  const events = docker("compose", "logs", "--no-color", "--since", since, "mock-erp")
    .split("\n")
    .flatMap((line) => {
      const start = line.indexOf("{");
      if (start < 0) return [];
      try {
        const value = JSON.parse(line.slice(start));
        return value.correlationId?.startsWith(`${correlationId}:`) ? [value] : [];
      } catch {
        return [];
      }
    });
  return summarizeErpHttp(events);
}

export function readWorkerHttpEvidence(runId, since) {
  const events = docker("compose", "logs", "--no-color", "--since", since, "worker")
    .split("\n")
    .flatMap((line) => {
      const start = line.indexOf("{");
      if (start < 0) return [];
      try {
        const value = JSON.parse(line.slice(start));
        if (value.runId !== runId) return [];
        const lookupFailure =
          value.msg === "Order processing was durably deferred." &&
          ["erp_lookup_failed", "erp_lookup_timeout"].includes(value.reason);
        if (value.msg !== "ERP confirmation request completed." && !lookupFailure) return [];
        return [
          {
            time: value.time,
            operation: lookupFailure ? "status_lookup" : value.operation,
            disposition: lookupFailure ? "temporarily_unavailable" : value.disposition,
            reason: value.reason,
            replayed: value.replayed,
            durationMs: value.durationMs,
            requestDeadlineMs: value.requestDeadlineMs,
          },
        ];
      } catch {
        return [];
      }
    });
  return {
    definition:
      "Worker-observed POST response telemetry and actual failed-lookup deferrals; a killed worker may omit completion telemetry.",
    replayResponsesObserved: events.filter((event) => event.replayed === true).length,
    lookupFailuresObserved: events.filter((event) => event.operation === "status_lookup").length,
    events,
  };
}

// Expected business totals only; configuration remains owned by the real seeded preset.
const presetCounts = {
  "preview-1k": [1000, 500, 500],
  "surge-5k": [5000, 500, 4500],
  "surge-10k": [10000, 500, 9500],
  "slow-erp-5k": [5000, 500, 4500],
  "laggy-erp-5k": [5000, 500, 4500],
  "idempotency-check-200": [400, 200, 0],
  "public-custom": [5000, 500, 4500],
  "admin-smoke-constant": [200, 200, 0],
  "admin-failure-path": [180, 180, 0],
  custom: [5000, 500, 4500],
};

function presetFixture(name) {
  const counts = presetCounts[name];
  if (!counts) return undefined;
  const [attempts, accepted, soldOut] = counts;
  return {
    name,
    presetSlug: name,
    config: null,
    expected: {
      plannedEmittedAttempts: attempts,
      acceptedReservations: accepted,
      reservedUnits: accepted,
      soldOutResponses: soldOut,
      duplicateReplayResponses: attempts - accepted - soldOut,
      confirmedOrders: accepted,
      notificationsRecorded: accepted,
      terminalOrderFailures: 0,
    },
  };
}

export async function runAcceptance(name, outputDirectory) {
  const baseName = name.startsWith("original-incident-")
    ? "original-incident"
    : name === "stable-high-latency"
      ? "latency-increase"
      : name;
  assert(
    [
      "original-incident",
      "original-incident-c1",
      "original-incident-c10",
      "original-incident-restart",
      "low-capacity-backlog",
      "duplicate-attempts",
      "concurrency-saturation-reference",
      "finite-outage",
      "stable-high-latency",
      ...Object.keys(presetCounts),
    ].includes(name),
    "Use finite-outage (container stop/start) or stable-high-latency (stable snapshot). Capacity changes are outside Compose verification: the mock honors the accepted snapshot; use the in-process resolveConfig integration test.",
  );
  const fixture =
    acceptanceScenarioFixtures().find((candidate) => candidate.name === baseName) ??
    presetFixture(name);
  if (name === "original-incident-c1")
    fixture.config.backpressureConfig.orderProcessConcurrency = 1;
  if (name === "original-incident-c10")
    fixture.config.backpressureConfig.orderProcessConcurrency = 10;
  assert(fixture, `Unknown acceptance fixture: ${name}`);
  if (name === "stable-high-latency") fixture.config.erpConfig.latencyMs = 3000;
  const api = serviceAddress("api", 4000);
  let apiUrl = api.url;
  const token = process.env.CONTROL_SERVICE_TOKEN;
  assert(token, "Load the runtime environment with scripts/run-with-env.mjs");
  mkdirSync(outputDirectory, { recursive: true });
  const lock = resolve(".cache", `runtime-acceptance-${api.project}.lock`);
  mkdirSync(resolve(".cache"), { recursive: true });
  mkdirSync(lock); // Atomic local ownership; never remove a foreign/stale lock automatically.
  const correlationId = `acceptance-${randomUUID()}`;
  const file = resolve(outputDirectory, `${name}-${correlationId}.json`);
  const report = {
    version: 1,
    harnessSha256: createHash("sha256")
      .update(readFileSync(new URL(import.meta.url)))
      .digest("hex"),
    scenario: name,
    mechanism:
      name === "stable-high-latency"
        ? "Separate verification snapshot derived from latency-increase with constant 3000 ms latency; exported fixture unchanged."
        : name === "finite-outage"
          ? "Stop mock-erp near acceptance +10s, start it after 30s stopped. Accepted snapshot unchanged."
          : "Stable accepted snapshot; process restart only when explicitly named.",
    fixture,
    correlationId,
    environment: {
      ...api,
      services: {
        worker: serviceAddress("worker", 4300),
        mockErp: serviceAddress("mock-erp", 4100),
        loadOrchestrator: serviceAddress("load-orchestrator", 4200),
      },
    },
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    node: process.version,
    startedAt: new Date().toISOString(),
    samples: [],
    status: "inconclusive",
    cleanup: "not-started",
  };
  const save = () => writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const request = async (path, body, method = "GET") => {
    let response;
    for (let attempt = 0; attempt < 7; attempt++) {
      response = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          "x-control-service-token": token,
          "x-demo-operator-mode": "admin",
          "x-correlation-id": correlationId,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      if (method !== "GET" || response.status !== 429 || attempt === 6) break;
      const seconds = Number(response.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 60_000) : 10_000;
      await response.body?.cancel();
      report.monitoringBackoffs ??= [];
      report.monitoringBackoffs.push({ at: new Date().toISOString(), path, waitMs });
      save();
      await delay(waitMs);
    }
    const value = await response.json();
    assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  let runId;
  let saleOfferId;
  try {
    const recovery = await request("/dashboard/recovery");
    assert(
      !recovery.currentRun || ["completed", "failed"].includes(recovery.currentRun.status),
      "Refusing to interfere with a nonterminal run",
    );
    const intent = {
      presetSlug: fixture.presetSlug ?? "public-custom",
      ...(fixture.config ? { configOverride: fixture.config } : {}),
    };
    report.estimate = await request("/demo/runs/estimate", intent, "POST");
    assert.equal(
      report.estimate.result.decision,
      "admitted",
      "Acceptance fixture preview must be admissible",
    );
    save();
    const start = startDemoRunResponseSchema.parse(
      await request("/demo/runs/start", { ...intent, correlationId }, "POST"),
    );
    runId = start.run.runId;
    saleOfferId = start.run.saleOfferId;
    report.run = start.run;
    report.queueLimitsAfterStart = queueLimits();
    const snapshot = start.run.configSnapshot;
    assertQueueLimits(report.queueLimitsAfterStart, {
      maxTps: snapshot.erpConfig.maxTps,
      concurrency: snapshot.backpressureConfig.orderProcessConcurrency,
    });
    save();
    console.log(JSON.stringify({ name, runId, file }));
    const acceptedAt = Date.parse(start.run.startedAt);
    const deadline = acceptedAt + 920_000;
    let restarted = false;
    while (Date.now() < deadline) {
      if (name === "finite-outage" && !report.outage && Date.now() - acceptedAt >= 10_000) {
        report.outage = {
          before: durableEvidence(runId),
          stopRequestedAt: new Date().toISOString(),
        };
        assert(report.outage.before.outstanding > 0, "Outage must overlap accepted pending work");
        save();
        docker("compose", "stop", "mock-erp");
        report.outage.stoppedAt = new Date().toISOString();
        save();
        // Observe the actual circuit opening; initial failure detection is not
        // governed by the open-circuit probe cadence. No extra dashboard polling.
        while (Date.now() - Date.parse(report.outage.stoppedAt) < 30_000) {
          const state = readProtectionState(runId);
          if (state?.availability_circuit_open) {
            report.outage.circuitOpenObservedAt = new Date().toISOString();
            report.outage.openState = state;
            save();
            break;
          }
          await delay(1000);
        }
      }
      if (
        report.outage?.stoppedAt &&
        !report.outage.restoredAt &&
        Date.now() - Date.parse(report.outage.stoppedAt) >= 30_000
      ) {
        report.outage.startRequestedAt = new Date().toISOString();
        docker("compose", "start", "mock-erp");
        docker("compose", "up", "-d", "--wait", "mock-erp");
        report.outage.restoredAt = new Date().toISOString();
        save();
      }
      if (name === "original-incident-restart" && !restarted && Date.now() - acceptedAt >= 65_000) {
        report.restart = { startedAt: new Date().toISOString(), before: durableEvidence(runId) };
        save();
        // Freeze the caller while its in-flight ERP requests finish. PostgreSQL
        // must prove external acceptance without a local result before we kill it.
        docker("compose", "kill", "--signal", "SIGSTOP", "worker");
        try {
          await delay(1_000);
          report.restart.frozen = durableEvidence(runId);
          save();
        } finally {
          // SIGKILL terminates a stopped process; restore services even if evidence fails.
          docker("compose", "kill", "--signal", "SIGKILL", "worker", "mock-erp");
          docker("compose", "restart", "api", "worker", "mock-erp");
          docker("compose", "up", "-d", "--wait", "api", "worker", "mock-erp");
        }
        report.restart.finishedAt = new Date().toISOString();
        report.restart.environment = serviceAddress("api", 4000);
        apiUrl = report.restart.environment.url;
        assert(
          report.restart.frozen.acceptedUnresolved > 0,
          "Restart must hit externally accepted work whose local response was lost",
        );
        report.restart.queueLimits = queueLimits();
        assertQueueLimits(report.restart.queueLimits, {
          maxTps: snapshot.erpConfig.maxTps,
          concurrency: snapshot.backpressureConfig.orderProcessConcurrency,
        });
        restarted = true;
      }
      const projection = await request(
        `/dashboard/recovery?knownRunId=${runId}&knownSaleOfferId=${saleOfferId}`,
      );
      assert.equal(projection.currentRun?.runId, runId, "Owned run identity");
      report.samples.push({
        at: new Date().toISOString(),
        status: projection.currentRun.status,
        progress: projection.runtimeProgress,
        business: projection.businessOutcome,
        erp: projection.erp,
      });
      save();
      if (["completed", "failed"].includes(projection.currentRun.status)) break;
      const nextOutageAction =
        name !== "finite-outage"
          ? Infinity
          : !report.outage
            ? acceptedAt + 10_000
            : !report.outage.restoredAt
              ? Date.parse(report.outage.stoppedAt) + 30_000
              : Infinity;
      await delay(Math.max(1, Math.min(15_000, nextOutageAction - Date.now())));
    }
    assert(
      Date.now() < deadline,
      "Harness observation deadline expired; not an application deadline",
    );
    report.durable = durableEvidence(runId);
    report.erpHttp = readErpHttpEvidence(correlationId, report.startedAt);
    report.workerHttp = readWorkerHttpEvidence(runId, report.startedAt);
    report.queueLimitsAtSettlement = queueLimits();
    assertQueueLimits(report.queueLimitsAtSettlement, idleErpDispatchLimits);
    report.detail = adminRunHistoryDetailResponseSchema.parse(
      await request(adminRunHistoryDetailPath(runId)),
    );
    save();
    assert.equal(
      report.detail.run.status,
      "completed",
      "Application settlement (harness deadline is not a business deadline)",
    );
    assertAcceptance(report.detail.summary, report.durable, fixture.expected);
    report.durationSeconds = report.detail.overallDurationMs / 1000;
    report.estimateError = {
      actualSeconds: report.durationSeconds,
      estimateSeconds: report.estimate.result.conservativeDurationSeconds,
      estimateToActualRatio:
        report.estimate.result.conservativeDurationSeconds / report.durationSeconds,
    };
    report.stableWindow = stableWindow(report.durable, report.erpHttp);
    report.calibration = calibrationEvidence(report.durable, snapshot.erpConfig.latencyMs);
    assert(report.erpHttp.posts > 0, "Attributable ERP HTTP evidence");
    assert(
      report.erpHttp.maximumInFlight <= snapshot.backpressureConfig.orderProcessConcurrency,
      "ERP HTTP in-flight maximum exceeds accepted concurrency",
    );
    if (name === "original-incident")
      assert(report.durationSeconds < 240, "incident settlement under 240 seconds");
    if (name === "finite-outage") assertOutageEvidence(report);
    if (name === "stable-high-latency") {
      assert(
        report.workerHttp.events.some((event) => event.disposition === "uncertain_result"),
        "High latency must actually produce retained uncertainty",
      );
      assert(report.erpHttp.lookups > 0, "Uncertainty must be reconciled by lookup");
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    if (runId) {
      try {
        report.durable = durableEvidence(runId);
      } catch (diagnosticError) {
        report.diagnosticError = diagnosticError.message;
      }
    }
  } finally {
    // Diagnostics are durable before any reset. Cleanup can never turn a failure into a pass.
    save();
    if (report.outage && !report.outage.restoredAt) {
      try {
        docker("compose", "start", "mock-erp");
        docker("compose", "up", "-d", "--wait", "mock-erp");
        report.outage.restoredAt = new Date().toISOString();
      } catch (error) {
        report.serviceRestorationError = error.message;
        report.status = "failed";
      }
      save();
    }
    if (runId) {
      try {
        const input = {
          apiBaseUrl: apiUrl,
          token,
          correlationId,
          runId,
          saleOfferId,
          // Allow two BullMQ stalled-job intervals for orphaned active jobs to settle.
          deadlineAt: Date.now() + 60_000,
          fetchImpl: fetch,
        };
        if (report.detail?.run.status !== "completed") await prepareExactRunCleanup(input);
        await teardownWithRetry(input);
        report.cleanup = "exact-run-teardown-passed";
      } catch (error) {
        report.cleanup = error.message;
        report.status = "failed";
      }
    }
    report.finishedAt = new Date().toISOString();
    save();
    rmSync(lock, { recursive: true });
    console.log(
      JSON.stringify({
        name,
        status: report.status,
        cleanup: report.cleanup,
        file,
        error: report.error,
      }),
    );
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [name, outputDirectory] = process.argv.slice(2);
  assert(
    name && outputDirectory,
    "Usage: node scripts/run-with-env.mjs node scripts/runtime-acceptance.mjs <fixture> <evidence-directory>",
  );
  const report = await runAcceptance(name, outputDirectory);
  if (report.status !== "passed") process.exitCode = 1;
}
