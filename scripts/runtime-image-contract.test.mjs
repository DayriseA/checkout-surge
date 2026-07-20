import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const readText = (file) => readFileSync(new URL(file, root), "utf8");
const readJson = (file) => JSON.parse(readText(file));

function readComposeServiceBlock(compose, serviceName) {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${serviceName}:`);
  assert.notEqual(start, -1, `Missing Compose service: ${serviceName}`);
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-z0-9][a-z0-9-]*:\s*$/.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function readComposeEnvironmentKeys(serviceBlock) {
  const lines = serviceBlock.split("\n");
  const start = lines.indexOf("    environment:");
  assert.notEqual(start, -1, "Missing service environment block");
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {4}\S/.test(line)) break;
    const match = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys.sort();
}

test("production Dockerfiles use production artifacts and non-root direct entrypoints", () => {
  const nodeService = readText("docker/Dockerfile.node-service");
  assert.match(nodeService, /api\|worker\|mock-erp/);
  assert.match(nodeService, /pnpm --filter="\$\{SERVICE_NAME\}\.\.\." build/);
  assert.match(nodeService, /COPY --from=build --chown=node:node \/deploy\/ \.[/]/);
  assert.match(nodeService, /USER node\s+CMD \["node", "dist\/index\.js"\]/);

  const load = readText("apps/load-orchestrator/Dockerfile");
  assert.match(load, /FROM grafana\/k6:2\.0\.0 AS k6-binary/);
  assert.match(load, /FROM build AS k6-compat/);
  assert.match(load, /install -d -o node -g node \/var\/lib\/checkout-surge\/load-orchestrator/);
  assert.match(load, /USER node\s+CMD \["node", "dist\/index\.js"\]/);

  const web = readText("apps/web/Dockerfile");
  assert.match(web, /\.next\/standalone/);
  assert.match(web, /USER node\s+CMD \["node", "apps\/web\/server\.js"\]/);

  const database = readText("packages/db/Dockerfile");
  assert.match(
    database,
    /USER node\s+CMD \["sh", "-c", "node dist\/scripts\/migrate\.js && node dist\/scripts\/seed\.js"\]/,
  );
});

test("deployable Node packages publish only their built service artifact", () => {
  for (const manifestPath of [
    "apps/api/package.json",
    "apps/worker/package.json",
    "apps/mock-erp/package.json",
    "apps/load-orchestrator/package.json",
  ]) {
    assert.deepEqual(readJson(manifestPath).files, ["dist"]);
  }
  assert.deepEqual(readJson("packages/db/package.json").files, ["dist", "drizzle"]);
});

test("Compose separates production, development, tooling, and k6-test images", () => {
  const compose = readText("docker-compose.yml");
  const runtimeTools = readComposeServiceBlock(compose, "runtime-tools");
  assert.match(compose, /dockerfile: docker\/Dockerfile\.node-service[\s\S]*SERVICE_NAME: api/);
  assert.match(compose, /dockerfile: apps\/load-orchestrator\/Dockerfile[\s\S]*target: runtime/);
  assert.match(compose, /runtime-tools:\s+profiles: \["tools"\]/);
  assert.match(compose, /k6-compat:\s+profiles: \["test-tools"\]/);
  assert.match(compose, /subnet: 172\.30\.0\.0\/24\s+ip_range: 172\.30\.0\.128\/25/);

  assert.deepEqual(readComposeEnvironmentKeys(runtimeTools), [
    "API_BASE_URL",
    "CONTROL_SERVICE_TOKEN",
    "DASHBOARD_RECOVERY_WINDOW_SECONDS",
    "DEMO_RUN_DRAIN_TIMEOUT_SECONDS",
    "DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS",
    "DIRECT_WEB_BASE_URL",
    "LOAD_ORCHESTRATOR_BASE_URL",
    "MOCK_ERP_BASE_URL",
    "NODE_ENV",
    "PUBLIC_CLIENT_COOKIE_SECRET",
    "RUNTIME_RECOVERY_SOAK_PROBE_INTERVAL_MS",
    "RUNTIME_RECOVERY_SOAK_SECONDS",
    "WEB_BASE_URL",
    "WORKER_HEALTH_BASE_URL",
  ]);
  assert.doesNotMatch(runtimeTools, /^ {6}<<:/m);

  const devCompose = readText(".devcontainer/docker-compose.yml");
  assert.equal((devCompose.match(/target: development-workspace/g) ?? []).length, 5);
  assert.equal((devCompose.match(/dockerfile: Dockerfile/g) ?? []).length, 5);

  const rootManifest = readJson("package.json");
  assert.match(rootManifest.scripts["test:k6-compat"], /k6-compat/);
  assert.doesNotMatch(rootManifest.scripts["test:k6-compat"], /load-orchestrator pnpm/);
});

test("Compose health probes use the cheap web-owned health route", () => {
  const compose = readText("docker-compose.yml");
  const web = readComposeServiceBlock(compose, "web");
  const proxy = readComposeServiceBlock(compose, "dashboard-proxy");

  assert.match(web, /127\.0\.0\.1:3000\/health/);
  assert.doesNotMatch(web, /127\.0\.0\.1:3000\/'/);
  assert.match(proxy, /127\.0\.0\.1:8080\/health/);
  assert.doesNotMatch(proxy, /127\.0\.0\.1:8080\/["]+/);
  assert.doesNotMatch(`${web}\n${proxy}`, /dashboard\/recovery/);
});

test("Compose gates Mock ERP on PostgreSQL and runtime smoke verifies ledger readiness", () => {
  const compose = readText("docker-compose.yml");
  const mockErp = readComposeServiceBlock(compose, "mock-erp");
  const worker = readComposeServiceBlock(compose, "worker");
  const healthSmoke = readText("scripts/runtime-health-check.mjs");

  assert.match(mockErp, /depends_on:\s+postgres:\s+condition: service_healthy/);
  assert.match(worker, /mock-erp:\s+condition: service_healthy/);
  assert.match(
    healthSmoke,
    /name: "mock_erp_readiness"[\s\S]*requiredChecks: \["confirmation_ledger_reachable"\]/,
  );
});

test("Dev Container provisions repo-scoped headless browser tooling", () => {
  const postCreate = readText(".devcontainer/post-create.sh");
  const browserInstaller = readText(".devcontainer/install-browser-tools.sh");
  const gitIgnore = readText(".gitignore");
  const playwrightCliConfig = readJson(".playwright/cli.config.json");
  const playwrightMcpConfig = readJson(".playwright/mcp.config.json");
  const rootManifest = readJson("package.json");

  assert.match(postCreate, /bash \.devcontainer\/install-browser-tools\.sh/);
  assert.match(browserInstaller, /@playwright\/cli@\$\{playwright_cli_version\}/);
  assert.match(browserInstaller, /@playwright\/mcp@\$\{playwright_mcp_version\}/);
  assert.match(browserInstaller, /playwright-cli install-browser --with-deps chromium/);
  assert.match(browserInstaller, /playwright-mcp install-browser chromium/);
  assert.match(browserInstaller, /playwright-cli -s="\$playwright_cli_smoke_session" open/);
  assert.match(browserInstaller, /chromium\.launch\(\{ headless: true, chromiumSandbox: true \}\)/);
  assert.doesNotMatch(JSON.stringify(rootManifest.devDependencies), /playwright/);

  assert.match(gitIgnore, /^\.codex\/$/m);
  assert.match(
    postCreate,
    /if \[ -e "\$repo_codex_config" \] \|\| \[ -L "\$repo_codex_config" \]; then\s+return/,
  );
  assert.match(postCreate, /\[mcp_servers\.playwright\]/);
  assert.match(postCreate, /enabled = false/);
  assert.match(postCreate, /command = "playwright-mcp"/);
  assert.match(postCreate, /args = \["--config", "\.playwright\/mcp\.config\.json"\]/);
  const expectedBrowserConfig = {
    browserName: "chromium",
    isolated: true,
    launchOptions: {
      headless: true,
      chromiumSandbox: true,
    },
  };
  assert.deepEqual(playwrightCliConfig.browser, expectedBrowserConfig);
  assert.equal(playwrightCliConfig.outputMode, "file");
  assert.deepEqual(playwrightMcpConfig.browser, expectedBrowserConfig);
  assert.deepEqual(playwrightMcpConfig.capabilities, ["core", "vision", "devtools"]);
});

test("Next standalone tracing and DB migration packaging are explicit", () => {
  const nextConfig = readText("apps/web/next.config.mjs");
  assert.match(nextConfig, /output: "standalone"/);
  assert.match(nextConfig, /outputFileTracingRoot: repositoryRoot/);

  const migrations = readText("packages/db/src/migrations.ts");
  assert.match(migrations, /new URL\("\.\.\/drizzle", import\.meta\.url\)/);
});

test("Docker build contexts exclude every environment-file variant", () => {
  const dockerIgnore = readText(".dockerignore");
  assert.match(dockerIgnore, /^\.env\*$/m);
  assert.doesNotMatch(dockerIgnore, /^!\.env/m);
  assert.match(dockerIgnore, /^\*\.pem$/m);
  assert.match(dockerIgnore, /^\*\.key$/m);
});
