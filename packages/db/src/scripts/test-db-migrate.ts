import { runDatabaseMigrations } from "../migrations.js";
import {
  assertTestEnvironment,
  validateDedicatedTestDatabaseUrl,
} from "../test-environment-safety.js";
import { requireEnv } from "./env.js";
import { createTestDatabaseIfMissing } from "./test-database.js";

const databaseUrl = requireEnv("TEST_DATABASE_URL");
assertTestEnvironment("migrate the test database");
const { databaseName } = validateDedicatedTestDatabaseUrl(databaseUrl);

await createTestDatabaseIfMissing(databaseUrl);
await runDatabaseMigrations({ databaseUrl, expectedDatabaseName: databaseName });

console.log("Isolated test database migrations applied.");
