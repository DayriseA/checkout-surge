import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const readText = (path) => readFileSync(new URL(path, root), "utf8");
const readManifest = (path) => JSON.parse(readText(path));

const owners = {
  unit: [
    ["@checkout-surge/contracts", "packages/contracts", "vitest.config.ts", "contracts-unit"],
    ["@checkout-surge/logger", "packages/logger", "vitest.config.ts", "logger-unit"],
    ["@checkout-surge/db", "packages/db", "vitest.unit.config.ts", "db-unit"],
    ["mock-erp", "apps/mock-erp", "vitest.unit.config.ts", "mock-erp-unit"],
    ["worker", "apps/worker", "vitest.unit.config.ts", "worker-unit"],
    ["web", "apps/web", "vitest.config.ts", "web-unit"],
    [
      "load-orchestrator",
      "apps/load-orchestrator",
      "vitest.unit.config.ts",
      "load-orchestrator-unit",
    ],
  ],
  api: [["api", "apps/api", "vitest.api.config.ts", "api-service"]],
  integration: [
    ["@checkout-surge/db", "packages/db", "vitest.integration.config.ts", "db-integration"],
    ["mock-erp", "apps/mock-erp", "vitest.integration.config.ts", "mock-erp-integration"],
    ["worker", "apps/worker", "vitest.integration.config.ts", "worker-integration"],
  ],
};

const packageEntries = Object.values(owners).flat();
const manifests = new Map(
  packageEntries.map(([, directory]) => [directory, readManifest(`${directory}/package.json`)]),
);

test("root tier commands use unfiltered Turbo discovery", () => {
  const scripts = readManifest("package.json").scripts;
  for (const tier of ["unit", "api", "integration"]) {
    assert.match(scripts[`test:${tier}`], new RegExp(`turbo run test:${tier}(?:$|\\s)`));
    assert.doesNotMatch(scripts[`test:${tier}`], /--filter/);
  }
  assert.equal(scripts["test:watch"], "turbo run test:unit:watch");
  assert.match(
    scripts["test:coverage"],
    /test:coverage:unit test:coverage:api test:coverage:integration/,
  );
  assert.doesNotMatch(scripts["test:coverage"], /--filter|&&/);
  assert.match(
    scripts["test:infra:up"],
    /docker compose -f docker-compose\.test\.yml up -d --wait postgres-test redis-test$/,
  );
});

test("package scripts declare only genuine owners and retain local configs and wrappers", () => {
  const expected = new Map([
    ["test:unit", new Set(owners.unit.map(([name]) => name))],
    ["test:api", new Set(owners.api.map(([name]) => name))],
    ["test:integration", new Set(owners.integration.map(([name]) => name))],
  ]);

  for (const [scriptName, expectedNames] of expected) {
    const actualNames = new Set();
    for (const [directory, manifest] of manifests) {
      if (manifest.scripts[scriptName]) actualNames.add(manifest.name);
      for (const command of Object.values(manifest.scripts))
        assert.doesNotMatch(command, /passWithNoTests/);
      if (!manifest.scripts[scriptName]) continue;
      const entry = owners[scriptName.slice(5)].find(
        ([name, path]) => name === manifest.name && path === directory,
      );
      assert.ok(entry, `${manifest.name} must not claim ${scriptName}`);
      assert.match(
        manifest.scripts[scriptName],
        new RegExp(`--config ${entry[2].replaceAll(".", "\\.")}(?:$|\\s)`),
      );
    }
    assert.deepEqual(actualNames, expectedNames);
  }

  for (const [, directory] of [...owners.api, ...owners.integration]) {
    assert.match(
      manifests.get(directory).scripts[
        `test:${owners.api.some(([, path]) => path === directory) ? "api" : "integration"}`
      ],
      /run-with-test-env\.mjs/,
    );
  }
  assert.match(manifests.get("apps/web").scripts["test:unit"], /run-with-test-env\.mjs/);
});

test("watch is persistent, non-cacheable, and limited to all unit owners", () => {
  const turboTask = readManifest("turbo.json").tasks["test:unit:watch"];
  assert.equal(turboTask.persistent, true);
  assert.equal(turboTask.cache, false);
  for (const [name, directory, config] of owners.unit) {
    const command = manifests.get(directory).scripts["test:unit:watch"];
    assert.match(command, /vitest --watch/);
    assert.match(command, new RegExp(`--config ${config.replaceAll(".", "\\.")}$`), name);
  }
  for (const [name, directory] of [...owners.api, ...owners.integration]) {
    if (owners.unit.some(([unitName]) => unitName === name)) continue;
    assert.equal(manifests.get(directory).scripts["test:unit:watch"], undefined);
  }
  assert.match(readText("apps/load-orchestrator/vitest.unit.config.ts"), /testTimeout: 15_000/);
});

test("coverage lanes share policy, use unique reports, and are bounded and non-cacheable", () => {
  const reportNames = new Set();
  for (const [tier, entries] of Object.entries(owners)) {
    for (const [name, directory, config, reportName] of entries) {
      const command = manifests.get(directory).scripts[`test:coverage:${tier}`];
      assert.match(
        command,
        new RegExp(`--config ${config.replaceAll(".", "\\.")} --coverage$`),
        name,
      );
      if (tier !== "unit" || directory === "apps/web") {
        assert.match(
          command,
          /run-with-test-env\.mjs/,
          `${name} ${tier} must retain its test environment wrapper`,
        );
      }
      const configText = readText(`${directory}/${config}`);
      assert.match(configText, /vitest\.coverage\.config/);
      assert.match(configText, new RegExp(`createV8CoverageConfig\\("${reportName}"\\)`));
      assert.equal(reportNames.has(reportName), false, `${reportName} must be unique`);
      reportNames.add(reportName);
    }
  }

  const turbo = readManifest("turbo.json").tasks;
  for (const taskName of [
    "test:api",
    "test:integration",
    "test:coverage:unit",
    "test:coverage:api",
    "test:coverage:integration",
  ]) {
    assert.equal(turbo[taskName].cache, false);
  }
  for (const taskName of ["test:coverage:unit", "test:coverage:api", "test:coverage:integration"]) {
    assert.notEqual(turbo[taskName].persistent, true);
    assert.deepEqual(turbo[taskName].dependsOn, ["^build"]);
  }

  const policy = readText("vitest.coverage.config.ts");
  assert.match(policy, /include: \["src\/\*\*\/\*\.\{ts,tsx\}"\]/);
  assert.match(policy, /exclude: \["src\/\*\*\/\*\.d\.ts"\]/);
  assert.match(policy, /reportOnFailure: true/);
  assert.match(policy, /reporter: \["text", "json-summary"\]/);
  for (const metric of ["statements", "branches", "functions", "lines"])
    assert.match(policy, new RegExp(`${metric}: 10`));
  assert.doesNotMatch(policy, /(?:statements|branches|functions|lines): 0/);
});
