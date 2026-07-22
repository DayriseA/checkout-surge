import { defineConfig } from "drizzle-kit";

// Drizzle snapshots cover schema declarations only. Required PostgreSQL
// functions, triggers, the extension, and the expression index remain explicit
// custom SQL in the single reviewed baseline.
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
