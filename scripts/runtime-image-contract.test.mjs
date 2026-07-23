import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const readText = (file) => readFileSync(new URL(file, root), "utf8");
const readJson = (file) => JSON.parse(readText(file));

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

test("standalone web tracing and database migration packaging are explicit", () => {
  const nextConfig = readText("apps/web/next.config.mjs");
  assert.match(nextConfig, /output: "standalone"/);
  assert.match(nextConfig, /outputFileTracingRoot: repositoryRoot/);

  const migrations = readText("packages/db/src/migrations.ts");
  assert.match(migrations, /new URL\("\.\.\/drizzle", import\.meta\.url\)/);
});

test("Docker build contexts exclude environment and private-key files", () => {
  const dockerIgnore = readText(".dockerignore");
  assert.match(dockerIgnore, /^\.env\*$/m);
  assert.doesNotMatch(dockerIgnore, /^!\.env/m);
  assert.match(dockerIgnore, /^\*\.pem$/m);
  assert.match(dockerIgnore, /^\*\.key$/m);
});
