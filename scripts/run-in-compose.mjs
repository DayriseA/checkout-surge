#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function runInCompose({
  script,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  spawn = spawnSync,
  writeError = (message) => console.error(message),
}) {
  if (!script) {
    writeError("Usage: run-in-compose.mjs <script> [args...]");
    return 1;
  }

  const forwardedArgs = args[0] === "--" ? args.slice(1) : args;

  const composeCheck = spawn("docker", ["compose", "ps", "--status", "running", "-q", "api"], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (composeCheck.status !== 0 || !composeCheck.stdout?.trim()) {
    const local = spawn(process.execPath, [script, ...forwardedArgs], {
      cwd,
      env,
      stdio: "inherit",
    });
    if (local.error) {
      writeError(`Failed to run ${script} locally: ${local.error.message}`);
      return 1;
    }
    return local.status ?? 1;
  }

  const tooling = spawn(
    "docker",
    [
      "compose",
      "--profile",
      "tools",
      "run",
      "--rm",
      "--build",
      "--no-deps",
      "runtime-tools",
      "node",
      script,
      ...forwardedArgs,
    ],
    { cwd, env, stdio: "inherit" },
  );

  if (tooling.error) {
    writeError(
      `Failed to run ${script} in the Compose tooling container: ${tooling.error.message}`,
    );
    return 1;
  }

  return tooling.status ?? 1;
}

const isEntrypoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const [script, ...args] = process.argv.slice(2);
  process.exitCode = runInCompose({ script, args });
}
