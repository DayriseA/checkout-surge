import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { assertSafePostgresUrl, assertSafeTestEnvironment } from "./test-environment-safety.mjs";

const safeEnvironment = {
  NODE_ENV: "test",
  TEST_DATABASE_URL: "postgresql://postgres:secret@localhost:56432/checkout_surge_test_db",
  TEST_REDIS_URL: "redis://:redis-secret@localhost:6380/3",
};

describe("test command environment safety", () => {
  it("accepts the base and a package-isolated database name", () => {
    for (const databaseName of ["checkout_surge_test", "checkout_surge_test_api"]) {
      assert.doesNotThrow(() =>
        assertSafePostgresUrl(`postgresql://localhost:56432/${databaseName}`),
      );
    }
  });

  it("keeps script and database validators in agreement", async () => {
    const source = readFileSync(
      new URL("../packages/db/src/test-environment-safety.ts", import.meta.url),
      "utf8",
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    });
    const { validateDedicatedTestDatabaseUrl } = await import(
      `data:text/javascript,${encodeURIComponent(compiled.outputText)}`
    );
    const targets = [
      "postgresql://localhost:56432/checkout_surge_test",
      "postgresql://localhost:56432/checkout_surge_test_api",
      "postgresql://localhost:56432/checkout_surge_test_mock_erp",
      "postgresql://localhost:56432/checkout_surge_test_backup",
      "postgresql://localhost:56432/checkout_surge_test%2Fother",
      "not a URL",
    ];
    const accepts = (validate, value) => {
      try {
        validate(value);
        return true;
      } catch {
        return false;
      }
    };
    assert.deepEqual(
      targets.map((target) => accepts(assertSafePostgresUrl, target)),
      targets.map((target) => accepts(validateDedicatedTestDatabaseUrl, target)),
    );
  });

  it("rejects malformed, empty, lookalike, and path-trick database targets", () => {
    for (const databaseUrl of [
      "not a URL",
      "postgresql://localhost:56432/",
      "postgresql://localhost:56432/checkout_surge_latest",
      "postgresql://localhost:56432/contest_production",
      "postgresql://localhost:56432/checkout_surge_test_backup",
      "postgresql://localhost:56432/checkout_surge_test/other",
      "postgresql://localhost:56432/checkout_surge_test%2Fother",
      "postgresql://localhost:56432/checkout_surge_test%5Cother",
    ]) {
      assert.throws(() => assertSafePostgresUrl(databaseUrl));
    }
  });

  it("requires the exact test environment", () => {
    for (const nodeEnvironment of [undefined, "development", "production", "Test"]) {
      assert.throws(() =>
        assertSafeTestEnvironment({ ...safeEnvironment, NODE_ENV: nodeEnvironment }),
      );
    }
  });

  it("normalizes omitted PostgreSQL and Redis ports and rejects defaults", () => {
    assert.throws(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        TEST_DATABASE_URL: "postgresql://localhost/checkout_surge_test_db",
      }),
    );
    assert.throws(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        TEST_REDIS_URL: "redis://localhost/3",
      }),
    );
  });

  it("allows the narrow default-port waiver without waiving names or environment", () => {
    assert.doesNotThrow(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        ALLOW_TEST_DEFAULT_PORTS: "1",
        TEST_DATABASE_URL: "postgresql://postgres-test:5432/checkout_surge_test_db",
        TEST_REDIS_URL: "redis://redis-test:6379/3",
      }),
    );
    assert.throws(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        ALLOW_TEST_DEFAULT_PORTS: "1",
        NODE_ENV: "development",
      }),
    );
    assert.throws(() =>
      assertSafeTestEnvironment({
        ...safeEnvironment,
        ALLOW_TEST_DEFAULT_PORTS: "1",
        TEST_DATABASE_URL: "postgresql://postgres-test/checkout_surge_test_backup",
      }),
    );
  });

  it("never includes credentials in diagnostics", () => {
    const password = "do-not-print-this-password";
    let message = "";
    try {
      assertSafePostgresUrl(
        `postgresql://postgres:${password}@localhost:5432/checkout_surge_test_db`,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.ok(message);
    assert.doesNotMatch(message, new RegExp(password));
  });

  it("rejects unsafe final URLs before spawning the requested command", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-with-test-env.mjs",
        process.execPath,
        "-e",
        'console.log("unsafe-command-was-spawned")',
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          TEST_DATABASE_URL: "postgresql://postgres:secret@localhost/checkout_surge_test",
          TEST_REDIS_URL: "redis://localhost:6380",
        },
      },
    );

    expectFailure(result.status, result.stdout, result.stderr);
  });
});

function expectFailure(status, stdout, stderr) {
  assert.notEqual(status, 0);
  assert.doesNotMatch(stdout, /unsafe-command-was-spawned/);
  assert.match(stderr, /TEST_DATABASE_URL targets localhost:5432/);
  assert.doesNotMatch(stderr, /secret/);
}
