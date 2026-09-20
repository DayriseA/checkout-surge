const allowedDatabaseNames = new Set([
  "checkout_surge_test",
  "checkout_surge_test_api",
  "checkout_surge_test_worker",
  "checkout_surge_test_db",
  "checkout_surge_test_web",
  "checkout_surge_test_load_orchestrator",
  "checkout_surge_test_contracts",
  "checkout_surge_test_logger",
  "checkout_surge_test_mock_erp",
]);

export interface ValidatedTestDatabaseTarget {
  databaseName: string;
  url: URL;
}

export function assertTestEnvironment(action: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(`Refusing to ${action}: NODE_ENV must be exactly "test".`);
  }
}

export function validateDedicatedTestDatabaseUrl(databaseUrl: string): ValidatedTestDatabaseTarget {
  const url = parsePostgresUrl(databaseUrl);
  const databaseName = decodeDatabaseName(url);

  if (!allowedDatabaseNames.has(databaseName)) {
    throw new Error(
      `Refusing destructive test database access: TEST_DATABASE_URL database "${databaseName || "<empty>"}" is not an approved isolated database. Use checkout_surge_test or a repository package-isolated name.`,
    );
  }

  const effectivePort = Number(url.port || 5432);
  if (effectivePort === 5432 && process.env.ALLOW_TEST_DEFAULT_PORTS !== "1") {
    throw new Error(
      `Refusing destructive test database access: TEST_DATABASE_URL targets ${url.hostname}:${effectivePort}, the default development port. Use isolated port 56432, or set ALLOW_TEST_DEFAULT_PORTS=1 only for a dedicated CI/devcontainer service.`,
    );
  }

  return { databaseName, url };
}

function parsePostgresUrl(databaseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Refusing destructive test database access: TEST_DATABASE_URL must be valid.");
  }

  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new Error(
      "Refusing destructive test database access: TEST_DATABASE_URL must be a PostgreSQL URL with a host.",
    );
  }

  return url;
}

function decodeDatabaseName(url: URL): string {
  if (!/^\/[^/]+$/.test(url.pathname)) {
    return "";
  }

  try {
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    return databaseName.includes("/") || databaseName.includes("\\") ? "" : databaseName;
  } catch {
    return "";
  }
}
