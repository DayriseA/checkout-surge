import { runDatabaseMigrations } from "../migrations.js";
import { requireEnv } from "./env.js";
import { createTestDatabaseIfMissing } from "./test-database.js";

const databaseUrl = requireEnv("TEST_DATABASE_URL");

await createTestDatabaseIfMissing(databaseUrl);
await runDatabaseMigrations({ databaseUrl });

console.log("Isolated test database migrations applied.");
