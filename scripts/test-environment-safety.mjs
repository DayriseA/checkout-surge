const allowedDatabaseNames = new Set([
  "checkout_surge_test",
  "checkout_surge_test_api",
  "checkout_surge_test_worker",
  "checkout_surge_test_db",
  "checkout_surge_test_web",
  "checkout_surge_test_mock_erp",
  "checkout_surge_test_load_orchestrator",
  "checkout_surge_test_contracts",
  "checkout_surge_test_logger",
]);

export function assertSafeTestEnvironment(env) {
  if (env.NODE_ENV !== "test") {
    throw new Error('Refusing destructive test setup: NODE_ENV must be exactly "test".');
  }

  assertSafePostgresUrl(env.TEST_DATABASE_URL, env.ALLOW_TEST_DEFAULT_PORTS);
  assertSafeRedisUrl(env.TEST_REDIS_URL, env.ALLOW_TEST_DEFAULT_PORTS);
}

export function assertSafePostgresUrl(value, allowDefaultPorts) {
  const url = parseRequiredUrl("TEST_DATABASE_URL", value, ["postgres:", "postgresql:"]);
  const databaseName = decodeDatabaseName(url);

  if (!allowedDatabaseNames.has(databaseName)) {
    throw new Error(
      `Refusing destructive test setup: TEST_DATABASE_URL database "${databaseName || "<empty>"}" is not an approved isolated database. Use checkout_surge_test or a repository package-isolated name.`,
    );
  }

  assertNonDevelopmentPort("TEST_DATABASE_URL", url, 5432, 56432, allowDefaultPorts);
  return { databaseName, url };
}

export function assertSafeRedisUrl(value, allowDefaultPorts) {
  const url = parseRequiredUrl("TEST_REDIS_URL", value, ["redis:", "rediss:"]);
  assertNonDevelopmentPort("TEST_REDIS_URL", url, 6379, 6380, allowDefaultPorts);
  return url;
}

function parseRequiredUrl(variableName, value, protocols) {
  if (!value) {
    throw new Error(`Refusing destructive test setup: ${variableName} is required.`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Refusing destructive test setup: ${variableName} must be a valid URL.`);
  }

  if (!protocols.includes(url.protocol) || !url.hostname) {
    throw new Error(
      `Refusing destructive test setup: ${variableName} must use ${protocols.join(" or ")} with a host.`,
    );
  }

  return url;
}

function decodeDatabaseName(url) {
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

function assertNonDevelopmentPort(
  variableName,
  url,
  defaultPort,
  expectedIsolatedPort,
  allowDefaultPorts,
) {
  const effectivePort = Number(url.port || defaultPort);
  if (effectivePort !== defaultPort || allowDefaultPorts === "1") {
    return;
  }

  throw new Error(
    `Refusing destructive test setup: ${variableName} targets ${url.hostname}:${effectivePort}, the default development port. Use the isolated port ${expectedIsolatedPort}, or set ALLOW_TEST_DEFAULT_PORTS=1 only for a dedicated CI/devcontainer service.`,
  );
}
