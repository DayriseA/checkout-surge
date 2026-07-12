#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const [script, ...args] = process.argv.slice(2);

if (!script) {
  console.error("Usage: run-in-compose.mjs <script> [args...]");
  process.exit(1);
}

const composeCheck = spawnSync("docker", ["compose", "ps", "--status", "running", "-q", "api"], {
  cwd: process.cwd(),
  env: process.env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});

if (composeCheck.status !== 0 || !composeCheck.stdout.trim()) {
  const local = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  process.exit(local.status ?? 1);
}

const result = spawnSync(
  "docker",
  [
    "compose",
    "exec",
    "-T",
    "-e",
    "WORKER_HEALTH_BASE_URL=http://worker:4300",
    "-e",
    "MOCK_ERP_BASE_URL=http://mock-erp:4100",
    "-e",
    "LOAD_ORCHESTRATOR_BASE_URL=http://load-orchestrator:4200",
    "-e",
    "WEB_BASE_URL=http://dashboard-proxy:8080",
    "api",
    "node",
    script,
    ...args,
  ],
  { cwd: process.cwd(), env: process.env, stdio: "inherit" },
);

if (result.error) {
  console.error(`Failed to run ${script} in the Compose API container: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
