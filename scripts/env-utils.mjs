import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(scriptDir, "..");

const redisDbByPackageSuffix = new Map([
  ["api", 1],
  ["worker", 2],
  ["db", 3],
  ["web", 4],
  ["load_orchestrator", 6],
  ["contracts", 7],
  ["logger", 8],
]);

export function runtimeEnvFilePaths(packageDir = findWorkspacePackageDir()) {
  return [
    path.join(repoRoot, ".env.example"),
    packageDir ? path.join(packageDir, ".env.example") : null,
    path.join(repoRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    packageDir ? path.join(packageDir, ".env") : null,
    packageDir ? path.join(packageDir, ".env.local") : null,
  ].filter(Boolean);
}

export function testEnvFilePaths() {
  return [path.join(repoRoot, ".env.test.example"), path.join(repoRoot, ".env.test")];
}

export function buildRuntimeEnv(baseEnv = process.env) {
  return mergeEnvFiles(runtimeEnvFilePaths(), baseEnv);
}

export function buildTestEnv(baseEnv = process.env) {
  const packageDir = findWorkspacePackageDir();
  const env = mergeEnvFiles(testEnvFilePaths(), baseEnv);
  return applyPackageTestIsolation(env, packageDir);
}

export function mergeEnvFiles(filePaths, baseEnv = process.env) {
  const fileEnv = {};

  for (const filePath of filePaths) {
    if (!filePath || !existsSync(filePath)) {
      continue;
    }

    Object.assign(fileEnv, parseEnv(readFileSync(filePath, "utf8")));
  }

  return { ...fileEnv, ...baseEnv };
}

export function runCommand(commandArgs, env) {
  if (commandArgs.length === 0) {
    console.error("Usage: run-with-env.mjs <command> [args...]");
    process.exitCode = 1;
    return;
  }

  const [command, ...args] = commandArgs;
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`Failed to start ${command}: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`${command} exited after receiving ${signal}.`);
      process.exitCode = 1;
      return;
    }

    process.exitCode = code ?? 1;
  });
}

function findWorkspacePackageDir(startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);

  while (isInsideOrSame(currentDir, repoRoot)) {
    if (currentDir !== repoRoot && existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }

    if (currentDir === repoRoot) {
      return null;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }

  return null;
}

function isInsideOrSame(childPath, parentPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function applyPackageTestIsolation(env, packageDir) {
  if (!packageDir) {
    return env;
  }

  const packageName = readPackageName(packageDir);
  const packageSuffix = packageName ? toPackageSuffix(packageName) : null;

  if (!packageSuffix) {
    return env;
  }

  const isolatedEnv = { ...env };

  if (isolatedEnv.TEST_DATABASE_URL) {
    isolatedEnv.TEST_DATABASE_URL = withDatabaseSuffix(
      isolatedEnv.TEST_DATABASE_URL,
      packageSuffix,
    );
  }

  const redisDb = redisDbByPackageSuffix.get(packageSuffix);

  if (isolatedEnv.TEST_REDIS_URL && redisDb !== undefined) {
    isolatedEnv.TEST_REDIS_URL = withRedisDatabase(isolatedEnv.TEST_REDIS_URL, redisDb);
  }

  return isolatedEnv;
}

function readPackageName(packageDir) {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    return typeof packageJson.name === "string" ? packageJson.name : null;
  } catch {
    return null;
  }
}

function toPackageSuffix(packageName) {
  const unscopedName = packageName.includes("/") ? packageName.split("/").at(-1) : packageName;

  return unscopedName
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function withDatabaseSuffix(databaseUrl, packageSuffix) {
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

  if (!databaseName) {
    throw new Error("TEST_DATABASE_URL must include a database name.");
  }

  const suffix = `_${packageSuffix}`;
  const isolatedName = databaseName.endsWith(suffix) ? databaseName : `${databaseName}${suffix}`;
  url.pathname = `/${isolatedName}`;

  return url.toString();
}

function withRedisDatabase(redisUrl, databaseIndex) {
  const url = new URL(redisUrl);
  url.pathname = `/${databaseIndex}`;
  return url.toString();
}
