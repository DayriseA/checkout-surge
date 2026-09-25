import { afterEach, describe, expect, it } from "vitest";
import {
  assertTestEnvironment,
  validateDedicatedTestDatabaseUrl,
} from "../../src/test-environment-safety.js";
import { requireTestDatabaseUrl } from "../../src/testing.js";

const originalNodeEnvironment = process.env.NODE_ENV;
const originalPortWaiver = process.env.ALLOW_TEST_DEFAULT_PORTS;
const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;

afterEach(() => {
  setEnvironment("NODE_ENV", originalNodeEnvironment);
  setEnvironment("ALLOW_TEST_DEFAULT_PORTS", originalPortWaiver);
  setEnvironment("TEST_DATABASE_URL", originalTestDatabaseUrl);
});

describe("destructive database helper safety", () => {
  it.each([
    "checkout_surge_test",
    "checkout_surge_test_db",
  ])("accepts approved database %s", (databaseName) => {
    process.env.ALLOW_TEST_DEFAULT_PORTS = "";
    expect(() =>
      validateDedicatedTestDatabaseUrl(`postgresql://localhost:56432/${databaseName}`),
    ).not.toThrow();
  });

  it.each([
    "checkout_surge_latest",
    "contest_production",
    "checkout_surge_test_backup",
    "",
    "checkout_surge_test%2Fother",
    "checkout_surge_test%5Cother",
  ])("rejects database target %s", (databaseName) => {
    expect(() =>
      validateDedicatedTestDatabaseUrl(`postgresql://localhost:56432/${databaseName}`),
    ).toThrow();
  });

  it("rejects malformed URLs without leaking credentials", () => {
    expect(() => validateDedicatedTestDatabaseUrl("not a URL")).toThrow("must be valid");
    const password = "credential-must-stay-private";
    expect(
      captureError(() =>
        validateDedicatedTestDatabaseUrl(
          `postgresql://postgres:${password}@localhost/checkout_surge_test_db`,
        ),
      ),
    ).not.toContain(password);
  });

  it.each([undefined, "development", "production"])("rejects NODE_ENV=%s", (nodeEnvironment) => {
    setEnvironment("NODE_ENV", nodeEnvironment);
    expect(() => assertTestEnvironment("reset test state")).toThrow(
      'NODE_ENV must be exactly "test"',
    );
  });

  it("normalizes an omitted port and limits the waiver to port policy", () => {
    expect(() =>
      validateDedicatedTestDatabaseUrl("postgresql://localhost/checkout_surge_test_db"),
    ).toThrow("localhost:5432");
    process.env.ALLOW_TEST_DEFAULT_PORTS = "1";
    expect(() =>
      validateDedicatedTestDatabaseUrl("postgresql://postgres-test/checkout_surge_test_db"),
    ).not.toThrow();
    expect(() =>
      validateDedicatedTestDatabaseUrl("postgresql://postgres-test/checkout_surge_test_backup"),
    ).toThrow("not an approved isolated database");
  });

  it("returns only a fully guarded TEST_DATABASE_URL", () => {
    setEnvironment("NODE_ENV", "test");
    process.env.TEST_DATABASE_URL = "postgresql://localhost:56432/checkout_surge_test_db";

    expect(requireTestDatabaseUrl()).toBe(process.env.TEST_DATABASE_URL);

    delete process.env.TEST_DATABASE_URL;
    expect(() => requireTestDatabaseUrl()).toThrow(
      "TEST_DATABASE_URL is required for test database access.",
    );

    process.env.TEST_DATABASE_URL = "postgresql://localhost:56432/checkout_surge";
    expect(() => requireTestDatabaseUrl()).toThrow("not an approved isolated database");

    process.env.TEST_DATABASE_URL = "postgresql://localhost:56432/checkout_surge_test_db";
    setEnvironment("NODE_ENV", "development");
    expect(() => requireTestDatabaseUrl()).toThrow('NODE_ENV must be exactly "test"');
  });
});

function captureError(action: () => void): string {
  try {
    action();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
