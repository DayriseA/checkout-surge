import { defineConfig } from "drizzle-kit";

// Drizzle snapshots cover schema declarations only. Hand-authored PostgreSQL
// functions, triggers, expression indexes, data migrations, and validation/audit
// blocks in drizzle/*.sql must remain explicit journal entries when generating.
const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl ?? "postgresql://postgres:postgres@localhost:5432/checkout_surge",
  },
  strict: true,
  verbose: true,
});
