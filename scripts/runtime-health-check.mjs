#!/usr/bin/env node

const checks = [
  {
    name: "api_liveness",
    url: joinUrl(envUrl("API_BASE_URL", "http://localhost:4000"), "/health/live"),
    kind: "json",
  },
  {
    name: "api_readiness",
    url: joinUrl(envUrl("API_BASE_URL", "http://localhost:4000"), "/health/ready"),
    kind: "readiness",
  },
  {
    name: "worker_readiness",
    url: joinUrl(envUrl("WORKER_HEALTH_BASE_URL", "http://localhost:4300"), "/health/ready"),
    kind: "readiness",
  },
  {
    name: "mock_erp_readiness",
    url: joinUrl(envUrl("MOCK_ERP_BASE_URL", "http://localhost:4100"), "/health/ready"),
    kind: "readiness",
  },
  {
    name: "load_orchestrator_readiness",
    url: joinUrl(envUrl("LOAD_ORCHESTRATOR_BASE_URL", "http://localhost:4200"), "/health/ready"),
    kind: "readiness",
    requiredChecks: ["api_readiness_reachable", "k6_binary_executable"],
  },
  {
    name: "dashboard_proxy",
    url: envUrl("WEB_BASE_URL", "http://localhost:8080"),
    kind: "html",
  },
];

const results = [];

for (const check of checks) {
  results.push(await runHttpCheck(check));
}

for (const result of results) {
  const marker = result.ok ? "ok" : "failed";
  console.log(`${marker} ${result.name}${result.detail ? ` - ${result.detail}` : ""}`);
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`Runtime health check failed: ${failed.length} check(s) failed.`);
  process.exit(1);
}

console.log("Runtime health check passed.");

async function runHttpCheck(check) {
  let response;

  try {
    response = await fetchWithTimeout(check.url, 5000);
  } catch (error) {
    return {
      name: check.name,
      ok: false,
      detail: error instanceof Error ? error.message : "request failed",
    };
  }

  if (!response.ok) {
    return {
      name: check.name,
      ok: false,
      detail: `HTTP ${response.status} from ${check.url}`,
    };
  }

  if (check.kind === "html") {
    return { name: check.name, ok: true, detail: check.url };
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    return {
      name: check.name,
      ok: false,
      detail: error instanceof Error ? error.message : "response was not JSON",
    };
  }

  if (check.kind === "readiness" && body.status !== "ok") {
    return {
      name: check.name,
      ok: false,
      detail: `status=${String(body.status)}`,
    };
  }

  for (const requiredCheck of check.requiredChecks ?? []) {
    const nested = Array.isArray(body.checks)
      ? body.checks.find((entry) => entry.name === requiredCheck)
      : null;
    if (nested?.status !== "ok") {
      return {
        name: check.name,
        ok: false,
        detail: `${requiredCheck}=${nested?.status ?? "missing"}`,
      };
    }
  }

  return { name: check.name, ok: true, detail: check.url };
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

function joinUrl(baseUrl, path) {
  return `${baseUrl}${path}`;
}
