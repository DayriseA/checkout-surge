#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";

const projectName =
  envValue("COMPOSITION_PROJECT_NAME")?.trim() || `checkout-surge-composition-${process.pid}`;
const controlToken = requiredEnv("CONTROL_SERVICE_TOKEN");
const hostPorts = {
  postgres: envValue("COMPOSITION_POSTGRES_PORT") || "55432",
  redis: envValue("COMPOSITION_REDIS_PORT") || "56379",
  api: envValue("COMPOSITION_API_PORT") || "54000",
  worker: envValue("COMPOSITION_WORKER_PORT") || "54300",
  erp: envValue("COMPOSITION_ERP_PORT") || "54100",
  load: envValue("COMPOSITION_LOAD_PORT") || "54200",
  web: envValue("COMPOSITION_WEB_PORT") || "53000",
  dashboard: envValue("COMPOSITION_DASHBOARD_PORT") || "58080",
};
const composeEnv = {
  ...process.env,
  COMPOSE_PROJECT_NAME: projectName,
  POSTGRES_HOST_PORT: hostPorts.postgres,
  REDIS_HOST_PORT: hostPorts.redis,
  API_HOST_PORT: hostPorts.api,
  WORKER_HEALTH_HOST_PORT: hostPorts.worker,
  MOCK_ERP_HOST_PORT: hostPorts.erp,
  LOAD_ORCHESTRATOR_HOST_PORT: hostPorts.load,
  WEB_HOST_PORT: hostPorts.web,
  DASHBOARD_PROXY_HOST_PORT: hostPorts.dashboard,
  DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS: "1",
};
const apiBaseUrl = `http://127.0.0.1:${hostPorts.api}`;
const dashboardBaseUrl = `http://127.0.0.1:${hostPorts.dashboard}`;
const timeoutMs = positiveIntegerEnv("COMPOSITION_RUN_TIMEOUT_MS", 240_000);

try {
  step("start isolated PostgreSQL and Redis", () => compose("up", "-d", "postgres", "redis"));
  step("migrate and seed isolated runtime", () => compose("run", "--rm", "runtime-setup"));
  step("build and start deployed topology", () => compose("up", "-d", "--build"));
  await waitForTopology();
  await characterizeSoldOutIdempotencyAndRecovery();
  await characterizeRepresentativeSurge();
  console.log("Composition characterization passed.");
} finally {
  if (envValue("COMPOSITION_KEEP_RUNTIME") !== "true") {
    step("remove isolated composition runtime", () =>
      compose("down", "--volumes", "--remove-orphans"),
    );
  } else {
    console.log(`Keeping Compose project ${projectName} for inspection.`);
  }
}

async function characterizeSoldOutIdempotencyAndRecovery() {
  console.log(
    "Characterizing sold-out-only traffic, idempotency, lifecycle, history, and recovery.",
  );
  const sseBefore = await openAndDisconnectSse();
  assert(sseBefore.includes("text/event-stream"), "dashboard SSE was not reachable before the run");

  const started = await startRun("public-custom", {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 20,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 1,
      maxDurationSeconds: 10,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 1,
    },
    erpConfig: {
      latencyMs: 1500,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
    },
  });
  const { runId, saleOfferId } = requireRunIdentity(started);
  const idempotencyKey = `composition-${runId}`;
  const first = await buy(runId, saleOfferId, idempotencyKey);
  const replay = await buy(runId, saleOfferId, idempotencyKey);
  assert(
    first.status === 202 && first.body.outcome === "reservation_secured",
    "first purchase did not reserve inventory",
  );
  assert(
    replay.status === 202 && replay.body.outcome === "reservation_secured",
    "duplicate purchase was not an idempotent replay",
  );
  assert(
    first.body.order?.id === replay.body.order?.id,
    "idempotent replay created a different order",
  );

  const observedStatuses = new Set([started.run.status]);
  const terminalRun = await waitForRun(runId, observedStatuses);
  assert(
    observedStatuses.has("active"),
    `run never exposed active status (${[...observedStatuses].join(", ")})`,
  );
  assert(
    observedStatuses.has("draining"),
    `run never exposed draining status (${[...observedStatuses].join(", ")})`,
  );
  if (terminalRun.status !== "completed") {
    const detail = await adminRunDetail(runId);
    throw new Error(
      `sold-out characterization run did not complete: ${detail.internalFailureReason}; ${JSON.stringify(terminalRun)}`,
    );
  }

  const summary = terminalRun;
  assert(
    summary.transportAttemptCounts?.plannedRequests === 20,
    "sold-out characterization planned request count drifted",
  );
  assert(
    summary.httpSummary?.soldOutResponses === 20,
    "traffic was not entirely sold out after inventory exhaustion",
  );
  assert(
    summary.businessOutcomeSummary?.acceptedReservations === 1,
    "idempotent replay changed accepted reservation count",
  );
  assert(
    summary.businessOutcomeSummary?.soldOutRejections === 20,
    "sold-out rejections were not durably summarized",
  );
  assert(
    summary.businessOutcomeSummary?.confirmedOrders === 1,
    "worker and ERP did not confirm the reserved order",
  );
  assert(
    summary.businessOutcomeSummary?.notificationsRecorded === 1,
    "notification handoff did not complete",
  );

  const detail = await adminRunDetail(runId);
  assert(
    detail.summary?.businessOutcomeSummary?.acceptedReservations === 1,
    "history detail did not preserve the single idempotent order",
  );
  assert(
    detail.erpAttemptSummary?.totalCount === 1,
    "history detail did not preserve the ERP attempt",
  );
  assert(
    detail.summary?.businessOutcomeSummary?.notificationsRecorded === 1,
    "history detail did not preserve the notification",
  );

  const recoveredThroughWeb = await jsonRequest(`${dashboardBaseUrl}/api/dashboard/recovery`);
  assert(
    recoveredThroughWeb.currentRun === null,
    "web recovery did not clear the finalized live run",
  );
  const historyPage = await textRequest(`${dashboardBaseUrl}/run-history/${runId}`);
  assert(historyPage.includes(runId), "browser history detail did not recover the finalized run");
  assert(
    (await statusRequest(`${dashboardBaseUrl}/run-history/${runId}`)) === 200,
    "finalized browser history detail did not return HTTP 200",
  );
  assert(
    (await statusRequest(`${dashboardBaseUrl}/run-history/not-a-uuid`)) === 404,
    "malformed browser history detail did not return HTTP 404",
  );
  assert(
    (await statusRequest(`${dashboardBaseUrl}/run-history/${randomUUID()}`)) === 404,
    "absent browser history detail did not return HTTP 404",
  );
  const sseAfter = await openAndDisconnectSse();
  assert(
    sseAfter.includes("text/event-stream"),
    "dashboard SSE could not reconnect after finalization",
  );
}

async function characterizeRepresentativeSurge() {
  console.log("Characterizing the deployed surge-10k preset.");
  const started = await startRun("surge-10k", {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10_000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 30,
      quantityPerAttempt: 1,
    },
  });
  const { runId } = requireRunIdentity(started);
  const observedStatuses = new Set([started.run.status]);
  const terminalRun = await waitForRun(runId, observedStatuses);
  assert(["completed", "failed"].includes(terminalRun.status), "surge-10k did not finalize");

  const detail = await adminRunDetail(runId);
  const summary = detail.summary;
  assert(
    summary.transportAttemptCounts?.plannedRequests === 10_000,
    "surge preset no longer plans 10,000 requests",
  );
  assert(
    summary.transportAttemptCounts.startedRequests === 10_000,
    "surge started request count did not match the 10,000 request plan",
  );
  assert(
    summary.transportAttemptCounts.completedRequests ===
      summary.transportAttemptCounts.startedRequests,
    "surge did not complete every started request",
  );
  assert(
    summary.httpSummary?.unexpectedResponses === 0,
    "surge produced unexpected HTTP responses",
  );
  assert(
    summary.httpSummary.transportFailures === 0,
    "surge load generator never reached the API on some dispatched attempts",
  );
  assert(
    summary.httpSummary.acceptedResponses + summary.httpSummary.soldOutResponses ===
      summary.transportAttemptCounts.completedRequests,
    "surge responses were not fully classified as accepted or sold out",
  );
  assert(
    summary.businessOutcomeSummary.confirmedOrders === summary.httpSummary.acceptedResponses,
    "surge worker/ERP confirmations do not match accepted reservations",
  );
  assert(
    summary.businessOutcomeSummary.notificationsRecorded === summary.httpSummary.acceptedResponses,
    "surge notifications do not match accepted reservations",
  );
  assert(
    summary.terminalInventorySnapshot?.remainingStock ===
      1000 - summary.httpSummary.acceptedResponses,
    "surge terminal inventory does not match accepted reservations",
  );
  assert(
    detail.summary?.businessOutcomeSummary?.acceptedReservations ===
      summary.httpSummary.acceptedResponses,
    "surge history order total does not match accepted reservations",
  );
  assert(
    detail.erpAttemptSummary?.totalCount === summary.httpSummary.acceptedResponses,
    "surge history ERP total does not match accepted reservations",
  );
  if (summary.trafficDeliverySummary.droppedIterations === 0) {
    assert(summary.status === "completed", "fully delivered surge did not complete");
    assert(
      summary.httpSummary.acceptedResponses === 1000,
      "fully delivered surge did not exhaust stock",
    );
    assert(
      summary.httpSummary.soldOutResponses === 9000,
      "fully delivered surge sold-out count drifted",
    );
  }
}

async function startRun(presetSlug, configOverride) {
  const correlationId = `composition-${presetSlug}-${Date.now()}`;
  const response = await fetch(`${apiBaseUrl}/demo/runs/start`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-control-service-token": controlToken,
      "x-demo-operator-mode": "admin",
    },
    body: JSON.stringify({
      presetSlug,
      correlationId,
      ...(configOverride ? { configOverride } : {}),
    }),
  });
  const body = await response.json();
  assert(
    response.status === 202,
    `could not start ${presetSlug}: HTTP ${response.status} ${JSON.stringify(body)}`,
  );
  return body;
}

async function buy(runId, saleOfferId, idempotencyKey) {
  const response = await fetch(`${apiBaseUrl}/buy`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ runId, saleOfferId, idempotencyKey, quantity: 1 }),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForRun(runId, observedStatuses) {
  const deadline = Date.now() + timeoutMs;
  let lastPollError;
  while (Date.now() < deadline) {
    try {
      const recovery = await jsonRequest(`${apiBaseUrl}/dashboard/recovery`);
      if (recovery.currentRun?.runId === runId) {
        observedStatuses.add(recovery.currentRun.status);
      } else {
        const history = await jsonRequest(`${apiBaseUrl}/demo/runs/history?page=1&pageSize=10`);
        const terminalRun = history.summaries?.find((candidate) => candidate.runId === runId);
        if (terminalRun) {
          const detail = await jsonRequest(`${apiBaseUrl}/demo/runs/history/${runId}`);
          return detail.summary;
        }
      }
      lastPollError = undefined;
    } catch (error) {
      lastPollError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for run ${runId}; observed ${[...observedStatuses].join(", ")}; last poll error: ${lastPollError instanceof Error ? lastPollError.message : "none"}`,
  );
}

async function waitForTopology() {
  const endpoints = [
    `${apiBaseUrl}/health/ready`,
    `http://127.0.0.1:${hostPorts.worker}/health/ready`,
    `http://127.0.0.1:${hostPorts.erp}/health/ready`,
    `http://127.0.0.1:${hostPorts.load}/health/ready`,
    `${dashboardBaseUrl}/`,
  ];
  const deadline = Date.now() + 120_000;
  for (const endpoint of endpoints) {
    while (true) {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
        if (response.ok) break;
      } catch {}
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${endpoint}`);
      await sleep(1000);
    }
  }
}

async function openAndDisconnectSse() {
  return new Promise((resolve, reject) => {
    const request = http.get(`${dashboardBaseUrl}/dashboard/events`, {
      headers: { accept: "text/event-stream" },
    });
    const timeout = setTimeout(() => {
      request.destroy(new Error("timed out opening dashboard SSE"));
    }, 5000);

    request.once("response", (response) => {
      clearTimeout(timeout);
      const contentType = response.headers["content-type"] || "";
      response.destroy();
      resolve(contentType);
    });
    request.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function jsonRequest(url, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  assert(response.ok, `${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function adminRunDetail(runId) {
  return jsonRequest(`${apiBaseUrl}/admin/demo/runs/history/${runId}`, {
    "x-control-service-token": controlToken,
  });
}

async function textRequest(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  assert(response.ok, `${url} returned HTTP ${response.status}`);
  return body;
}

async function statusRequest(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  await response.body?.cancel();
  return response.status;
}

function requireRunIdentity(started) {
  assert(started.run?.runId, "start response omitted runId");
  assert(started.run?.saleOfferId, "start response omitted saleOfferId");
  return { runId: started.run.runId, saleOfferId: started.run.saleOfferId };
}

function compose(...args) {
  const result = spawnSync(
    "docker",
    ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", ...args],
    {
      cwd: process.cwd(),
      env: composeEnv,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`docker compose ${args.join(" ")} exited with ${result.status}`);
}

function step(label, action) {
  console.log(`\n[composition] ${label}`);
  action();
}

function requiredEnv(name) {
  const value = envValue(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const value = envValue(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function envValue(name) {
  return process.env[name];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
