import { runDatabaseMigrations } from "../migrations.js";
import { requireEnv } from "./env.js";

await runDatabaseMigrations({
  databaseUrl: requireEnv("DATABASE_URL"),
});

console.log("Database migrations applied.");
