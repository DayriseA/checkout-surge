import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const readText = (file) => readFileSync(new URL(file, root), "utf8");
const readJson = (file) => JSON.parse(readText(file));

test("Docker prune stages install and run the resolved root Turbo version", () => {
  const rootImporter = readText("pnpm-lock.yaml").match(
    /^ {2}\.:\n([\s\S]*?)(?=^ {2}\S|$(?![\s\S]))/m,
  );
  assert.ok(rootImporter, "root lockfile importer must exist");
  const turbo = rootImporter[1].match(/^ {6}turbo:\n {8}specifier: [^\n]+\n {8}version: (\S+)/m);
  assert.ok(turbo, "root importer must resolve Turbo");
  const resolvedVersion = turbo[1];

  for (const file of [
    "docker/Dockerfile.node-service",
    "apps/load-orchestrator/Dockerfile",
    "apps/web/Dockerfile",
    "packages/db/Dockerfile",
    "Dockerfile",
  ]) {
    const dockerfile = readText(file);
    const instructions = dockerfile.replace(/[ \t]*\\\n\s*/g, " ");
    assert.match(instructions, /^RUN npm install -g turbo@\S+$/m, file);
    assert.match(
      instructions,
      /^RUN (?:case "\$\{SERVICE_NAME\}" in .* esac && )?turbo prune \S+ --docker$/m,
      file,
    );
    for (const [, version] of dockerfile.matchAll(/turbo@([^\s"']*)/g)) {
      assert.equal(version, resolvedVersion, file);
    }
  }
});

test("production Dockerfiles use production artifacts and non-root direct entrypoints", () => {
  const nodeService = readText("docker/Dockerfile.node-service");
  assert.match(nodeService, /api\|worker\|mock-erp/);
  assert.match(nodeService, /pnpm --filter="\$\{SERVICE_NAME\}\.\.\." build/);
  assert.match(nodeService, /COPY --from=build --chown=node:node \/deploy\/ \.[/]/);
  assert.match(nodeService, /USER node\s+CMD \["node", "dist\/index\.js"\]/);

  const load = readText("apps/load-orchestrator/Dockerfile");
  assert.match(load, /FROM grafana\/k6:2\.0\.0 AS k6-binary/);
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

test("runtime tooling image carries only operational scripts and the built contracts package", () => {
  const tooling = readText("Dockerfile");
  assert.match(tooling, /FROM node:22-bookworm-slim AS runtime-tools/);
  assert.match(
    tooling,
    /pnpm --filter="@checkout-surge\/contracts" deploy --legacy --prod \/deploy/,
  );
  assert.match(
    tooling,
    /COPY --from=runtime-tools-build --chown=node:node \/deploy\/ \.\/packages\/contracts\/\s+COPY --chown=node:node scripts\/ \.\/scripts\/\s+USER node/,
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

test("standalone web tracing is explicit", () => {
  const nextConfig = readText("apps/web/next.config.mjs");
  assert.match(nextConfig, /output: "standalone"/);
  assert.match(nextConfig, /outputFileTracingRoot: repositoryRoot/);
});

test("Docker build contexts exclude environment and private-key files", () => {
  const dockerIgnore = readText(".dockerignore");
  assert.match(dockerIgnore, /^\.env\*$/m);
  assert.doesNotMatch(dockerIgnore, /^!\.env/m);
  assert.match(dockerIgnore, /^\*\.pem$/m);
  assert.match(dockerIgnore, /^\*\.key$/m);
});

test("dashboard proxy config includes Codespaces origin-rewrite fragments", () => {
  const compose = readText("docker-compose.yml");
  assert.match(compose, /CODESPACES: \$\{CODESPACES:-false\}/);
  assert.match(compose, /WEB_ORIGIN: \$\{WEB_ORIGIN:-http:\/\/localhost:8080\}/);

  const caddy = readText("infra/caddy/Caddyfile");
  assert.match(caddy, /Origin\} == "http:\/\/localhost:8080"/);
  assert.match(caddy, /Origin\} == "https:\/\/localhost:8080"/);
  assert.match(caddy, /Sec-Fetch-Site\} == "same-origin"/);
  assert.match(caddy, /Sec-Fetch-Mode\} == "cors"/);
  assert.match(caddy, /request_header @codespaces_forwarded_origin Origin/);
});
