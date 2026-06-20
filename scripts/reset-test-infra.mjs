#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { buildTestEnv, repoRoot } from "./env-utils.mjs";

const env = buildTestEnv();
const composeArgs = ["compose", "-f", path.join(repoRoot, "docker-compose.test.yml")];

await run("docker", [...composeArgs, "down", "--volumes", "--remove-orphans"]);
await run("docker", [...composeArgs, "up", "-d", "postgres-test", "redis-test"]);
await waitForService("postgres-test", [
  ...composeArgs,
  "exec",
  "-T",
  "postgres-test",
  "pg_isready",
  "-U",
  "postgres",
  "-d",
  "checkout_surge_test",
]);
await waitForService("redis-test", [
  ...composeArgs,
  "exec",
  "-T",
  "redis-test",
  "redis-cli",
  "ping",
]);

console.log("Isolated test PostgreSQL and Redis have been reset.");

function run(command, args, options = {}) {
  const quiet = options.quiet === true;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      shell: process.platform === "win32",
      stdio: quiet ? "ignore" : "inherit",
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited after receiving ${signal}.`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
        return;
      }

      resolve();
    });
  });
}

async function waitForService(serviceName, args) {
  const maxAttempts = 30;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await run("docker", args, { quiet: true });
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`${serviceName} did not become ready: ${error.message}`);
      }

      await sleep(1000);
    }
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
