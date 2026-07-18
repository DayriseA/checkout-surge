#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultLimiterWindowSeconds = 60;
const defaultProbeIntervalMs = 5_000;

export function readRecoverySoakConfig(env = process.env) {
  const limiterWindowSeconds = positiveIntegerEnv(
    env,
    "DASHBOARD_RECOVERY_WINDOW_SECONDS",
    defaultLimiterWindowSeconds,
  );
  const soakSeconds = positiveIntegerEnv(
    env,
    "RUNTIME_RECOVERY_SOAK_SECONDS",
    limiterWindowSeconds * 2 + 5,
  );
  const config = {
    directWebBaseUrl: envUrl(env, "DIRECT_WEB_BASE_URL", "http://localhost:3000"),
    dashboardBaseUrl: envUrl(env, "WEB_BASE_URL", "http://localhost:8080"),
    limiterWindowSeconds,
    soakSeconds,
    probeIntervalMs: positiveIntegerEnv(
      env,
      "RUNTIME_RECOVERY_SOAK_PROBE_INTERVAL_MS",
      defaultProbeIntervalMs,
    ),
  };
  assertSoakCoversTwoWindows(config);
  return config;
}

export function assertSoakCoversTwoWindows({ limiterWindowSeconds, soakSeconds }) {
  if (soakSeconds <= limiterWindowSeconds * 2) {
    throw new Error(
      `RUNTIME_RECOVERY_SOAK_SECONDS must be greater than two DASHBOARD_RECOVERY_WINDOW_SECONDS windows (${limiterWindowSeconds * 2}).`,
    );
  }
}

export async function runRecoverySoak({
  config = readRecoverySoakConfig(),
  fetch = globalThis.fetch,
  now = Date.now,
  wait = delay,
  write = console.log,
} = {}) {
  assertSoakCoversTwoWindows(config);
  const deadline = now() + config.soakSeconds * 1_000;
  let probeRounds = 0;

  write(
    `Soaking direct-web and proxy health for ${config.soakSeconds}s (>2 x ${config.limiterWindowSeconds}s limiter windows).`,
  );

  while (now() < deadline) {
    await assertWebHealth(`${config.directWebBaseUrl}/health`, "direct web", fetch);
    await assertWebHealth(`${config.dashboardBaseUrl}/health`, "proxy-to-web", fetch);
    probeRounds += 1;
    const remainingMs = deadline - now();
    if (remainingMs > 0) await wait(Math.min(config.probeIntervalMs, remainingMs));
  }

  const rootResponse = await fetchWithTimeout(fetch, `${config.dashboardBaseUrl}/`, 10_000);
  if (!rootResponse.ok || !(await rootResponse.text()).includes("Checkout-Surge demo")) {
    throw new Error("Public page was not reachable after the recovery soak.");
  }

  const firstVisitor = await readIdleRecovery(config.dashboardBaseUrl, fetch);
  const secondVisitor = await readIdleRecovery(config.dashboardBaseUrl, fetch);
  if (firstVisitor.cookie === secondVisitor.cookie) {
    throw new Error("Fresh browser recovery sessions received the same visitor cookie.");
  }

  write(
    `Recovery soak passed after ${probeRounds} probe rounds: health remained reachable and two fresh signed visitors recovered authoritative idle state. Browser Start-control convergence is covered by the deterministic PublicDemoEntry component test.`,
  );
  return { probeRounds };
}

async function assertWebHealth(url, name, fetch) {
  const response = await fetchWithTimeout(fetch, url, 5_000);
  const body = await response.json();
  if (!response.ok || body.service !== "web" || body.status !== "ok") {
    throw new Error(`${name} health failed with HTTP ${response.status}.`);
  }
}

async function readIdleRecovery(dashboardBaseUrl, fetch) {
  const response = await fetchWithTimeout(
    fetch,
    `${dashboardBaseUrl}/api/dashboard/recovery`,
    10_000,
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Fresh visitor recovery failed with HTTP ${response.status}.`);
  }
  if (body.currentRun !== null || body.scope !== null) {
    throw new Error("Recovery soak requires an idle runtime; reset the demo and retry.");
  }
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Recovery BFF did not issue a signed visitor cookie.");
  return { cookie };
}

async function fetchWithTimeout(fetch, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function envUrl(env, name, fallback) {
  return (env[name]?.trim() || fallback).replace(/\/+$/, "");
}

function positiveIntegerEnv(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  runRecoverySoak().catch((error) => {
    console.error(error instanceof Error ? error.message : "Runtime recovery soak failed.");
    process.exitCode = 1;
  });
}
