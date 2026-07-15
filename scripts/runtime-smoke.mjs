#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { checkDashboardSseStream } from "./runtime-smoke-sse.mjs";

const requiredServices = [
  "postgres",
  "redis",
  "api",
  "worker",
  "mock-erp",
  "load-orchestrator",
  "web",
  "dashboard-proxy",
];

const failures = [];

runStep("compose_config", () => runCommand("docker", ["compose", "config"], { silent: true }));
runStep("compose_services_running", assertComposeServicesRunning);
runStep("health_check", () =>
  runCommand("node", ["scripts/run-in-compose.mjs", "scripts/runtime-health-check.mjs"]),
);
runStep("load_orchestrator_k6_binary", () =>
  runCommand("docker", [
    "compose",
    "exec",
    "-T",
    "load-orchestrator",
    "/usr/local/bin/k6",
    "version",
  ]),
);

function runStep(name, action) {
  try {
    const result = action();
    if (result && typeof result.then === "function") {
      throw new Error("runStep received an async action. Use top-level await.");
    }
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push({
      name,
      detail: error instanceof Error ? error.message : String(error),
    });
    console.error(`failed ${name}`);
  }
}

async function runAsyncStep(name, action) {
  try {
    await action();
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push({
      name,
      detail: error instanceof Error ? error.message : String(error),
    });
    console.error(`failed ${name}`);
  }
}

await runAsyncStep("dashboard_same_origin_recovery", checkDashboardRecovery);
await runAsyncStep("dashboard_sse_reachable", checkDashboardSse);

if (failures.length > 0) {
  console.error(`Runtime smoke failed: ${failures.length} step(s) failed.`);
  for (const failure of failures) {
    console.error(`- ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}

console.log("Runtime smoke passed.");

function assertComposeServicesRunning() {
  const output = runCommand("docker", ["compose", "ps", "--format", "json"], { silent: true });
  const services = parseComposePsJson(output);

  for (const serviceName of requiredServices) {
    const service = services.find((entry) => entry.Service === serviceName);
    if (!service) {
      throw new Error(`${serviceName} is missing from docker compose ps.`);
    }
    if (service.State !== "running") {
      throw new Error(`${serviceName} is ${service.State}.`);
    }
    if (service.Health && service.Health !== "healthy") {
      throw new Error(`${serviceName} health is ${service.Health}.`);
    }
  }
}

async function checkDashboardRecovery() {
  const baseUrl = envUrl("WEB_BASE_URL", "http://localhost:8080");
  const response = await fetchWithTimeout(`${baseUrl}/api/dashboard/recovery`, 5000);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload.recoveredAt !== "string") {
    throw new Error("Dashboard recovery response did not include recoveredAt.");
  }
}

async function checkDashboardSse() {
  const baseUrl = envUrl("WEB_BASE_URL", "http://localhost:8080");
  await checkDashboardSseStream(`${baseUrl}/dashboard/events`);
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

function parseComposePsJson(output) {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function envUrl(name, fallback) {
  return (process.env[name]?.trim() || fallback).replace(/\/+$/, "");
}
