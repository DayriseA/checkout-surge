#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";

const dashboardBaseUrl = envUrl("WEB_BASE_URL", "http://localhost:8080");
const apiBaseUrl = envUrl("API_BASE_URL", "http://localhost:4000");
const controlServiceToken = process.env.CONTROL_SERVICE_TOKEN?.trim();
const timeoutMs = positiveIntegerEnv("RUNTIME_SMOKE_LOAD_RUN_TIMEOUT_MS", 60_000);
const publicRunBudgetWindowSeconds = positiveIntegerEnv("PUBLIC_RUN_BUDGET_WINDOW_SECONDS", 300);
const correlationId = `runtime-smoke-load-${Date.now()}`;
const smokeVisitorId = "00000000-0000-4000-8000-000000000009";
const publicBudgetWindowStart = Math.floor(Date.now() / (publicRunBudgetWindowSeconds * 1000));

if (!controlServiceToken) {
  console.error("CONTROL_SERVICE_TOKEN is required for runtime load smoke.");
  process.exit(1);
}

let runId = null;
let saleOfferId = null;

try {
  await resetRunningDemo();
  const started = await startSmokeRun();
  runId = started.run.runId;
  saleOfferId = started.run.saleOfferId ?? null;

  if (!saleOfferId) {
    throw new Error("Started run did not include a generated saleOfferId.");
  }

  const recovered = await waitForTrafficCompletion(runId);
  if (recovered.recentMetrics.length === 0) {
    throw new Error("Dashboard recovery did not expose recent k6 metric samples.");
  }

  console.log(
    `Runtime load smoke passed for run ${runId} with trafficStatus=${recovered.currentRun.trafficStatus}.`,
  );
} finally {
  if (runId && saleOfferId) {
    cleanupSmokeRun({ runId, saleOfferId });
  }
}

async function resetRunningDemo() {
  const response = await fetchWithTimeout(`${apiBaseUrl}/admin/demo/reset`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "x-control-service-token": controlServiceToken,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Runtime reset failed with HTTP ${response.status}: ${body}`);
  }
}

async function startSmokeRun() {
  const response = await fetchWithTimeout(`${dashboardBaseUrl}/api/demo/runs/start`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: signedPublicVisitorCookie(smokeVisitorId),
    },
    body: JSON.stringify({
      presetSlug: "public-custom",
      correlationId,
      configOverride: {
        trafficConfig: {
          mode: "steady-arrival-rate",
          ratePerSecond: 2,
          durationSeconds: 2,
          startDelaySeconds: 0,
          quantityPerAttempt: 1,
          k6Vus: {
            preAllocatedVus: 1,
            maxVus: 4,
          },
        },
        inventoryConfig: {
          startingStock: 10,
          quantityPerCheckout: 1,
          reservationHoldMinutes: 15,
        },
        erpConfig: {
          latencyMs: 0,
          maxTps: 100,
          errorRate: 0,
          forcedOutage: false,
          requestTimeoutMs: 2000,
        },
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Dashboard run start failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }

  return payload;
}

async function waitForTrafficCompletion(expectedRunId) {
  const startedAt = Date.now();
  let lastRun = null;

  while (Date.now() - startedAt < timeoutMs) {
    const recovery = await readRecovery();
    lastRun = recovery.currentRun;

    if (
      lastRun?.runId === expectedRunId &&
      (lastRun.trafficStatus === "succeeded" || lastRun.trafficStatus === "failed")
    ) {
      if (lastRun.trafficStatus === "failed") {
        throw new Error(`Smoke run traffic failed: ${lastRun.failureReason ?? "unknown"}`);
      }
      return recovery;
    }

    await sleep(1000);
  }

  throw new Error(
    `Timed out waiting for smoke run traffic completion. Last status: ${
      lastRun ? `${lastRun.status}/${lastRun.trafficStatus}` : "missing"
    }.`,
  );
}

async function readRecovery() {
  const response = await fetchWithTimeout(`${dashboardBaseUrl}/api/dashboard/recovery`, {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Dashboard recovery failed with HTTP ${response.status}.`);
  }

  return response.json();
}

function cleanupSmokeRun(input) {
  console.log(`Cleaning runtime smoke run ${input.runId}.`);
  cleanupPostgresRows(input);
  cleanupRedisKeys(input);
  cleanupPublicBudgetKeys();
}

function cleanupPostgresRows(input) {
  const runId = sqlUuidLiteral(input.runId, "runId");
  const saleOfferId = sqlUuidLiteral(input.saleOfferId, "saleOfferId");
  const sql = `
delete from simulated_notifications where run_id = ${runId} or sale_offer_id = ${saleOfferId};
delete from erp_attempts where run_id = ${runId};
delete from order_events where run_id = ${runId} or sale_offer_id = ${saleOfferId};
delete from orders where run_id = ${runId} or sale_offer_id = ${saleOfferId};
delete from reservations where run_id = ${runId} or sale_offer_id = ${saleOfferId};
delete from reservation_pending_persistence where run_id = ${runId} or sale_offer_id = ${saleOfferId};
delete from demo_run_reservation_outcomes where run_id = ${runId};
delete from demo_run_finalizations where run_id = ${runId};
delete from demo_run_summaries where run_id = ${runId};
delete from demo_run_sale_contexts where run_id = ${runId} or sale_offer_id = ${saleOfferId};
delete from demo_runs where id = ${runId};
delete from sale_offers where id = ${saleOfferId} and purpose = 'generated_run';
`;

  runCommand(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "checkout_surge",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { silent: true },
  );
}

function cleanupRedisKeys(input) {
  const keys = new Set([
    `demo-run:${input.runId}:sale-eligibility`,
    `demo-run:${input.runId}:traffic-metrics`,
  ]);

  for (const pattern of [`inventory:${input.saleOfferId}:*`, `demo-run:${input.runId}:*`]) {
    const output = runCommand(
      "docker",
      ["compose", "exec", "-T", "redis", "redis-cli", "--scan", "--pattern", pattern],
      { silent: true },
    );

    for (const key of output.split(/\r?\n/).filter(Boolean)) {
      keys.add(key);
    }
  }

  const keyList = [...keys];
  if (keyList.length === 0) {
    return;
  }

  runCommand("docker", ["compose", "exec", "-T", "redis", "redis-cli", "DEL", ...keyList], {
    silent: true,
  });
}

function cleanupPublicBudgetKeys() {
  const globalKey = `demo-run:public-budget:${publicBudgetWindowStart}:global`;
  const visitorKey = `demo-run:public-budget:${publicBudgetWindowStart}:visitor:${smokeVisitorId}`;

  runCommand("docker", ["compose", "exec", "-T", "redis", "redis-cli", "DEL", visitorKey], {
    silent: true,
  });
  runCommand(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "redis",
      "redis-cli",
      "EVAL",
      "local v = redis.call('DECR', KEYS[1]); if v <= 0 then redis.call('DEL', KEYS[1]); end; return v",
      "1",
      globalKey,
    ],
    { silent: true },
  );
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    return await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: options.silent ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = options.silent ? result.stderr.trim() : "";
    throw new Error(stderr || `${command} ${args.join(" ")} exited with ${result.status}.`);
  }

  return options.silent ? result.stdout : "";
}

function envUrl(name, fallback) {
  return (process.env[name]?.trim() || fallback).replace(/\/+$/, "");
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function sqlUuidLiteral(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }

  return `'${value}'`;
}

function signedPublicVisitorCookie(visitorId) {
  const secret = process.env.PUBLIC_CLIENT_COOKIE_SECRET?.trim();
  if (!secret) {
    throw new Error("PUBLIC_CLIENT_COOKIE_SECRET is required for runtime load smoke.");
  }

  const signature = createHmac("sha256", secret).update(visitorId).digest("base64url");
  const value = encodeURIComponent(`${visitorId}.${signature}`);
  return `checkout_surge_public_visitor=${value}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
