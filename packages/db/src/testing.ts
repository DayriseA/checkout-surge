import path from "node:path";
import postgres from "postgres";
import { createDatabaseConnection } from "./client.js";
import { runDatabaseMigrations } from "./migrations.js";

const resettableTables = [
  "demo_run_summaries",
  "demo_run_finalizations",
  "demo_run_reservation_outcomes",
  "simulated_notifications",
  "reservation_pending_persistence",
  "order_events",
  "erp_attempts",
  "orders",
  "reservations",
  "demo_run_sale_contexts",
  "demo_runs",
  "demo_presets",
  "public_runtime_policies",
  "sale_offers",
  "products",
] as const;

export interface ResetTestDatabaseOptions {
  databaseUrl?: string;
  migrationsFolder?: string;
}

export async function resetTestDatabase(options: ResetTestDatabaseOptions = {}): Promise<void> {
  const databaseUrl = options.databaseUrl ?? process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required to reset test database state.");
  }

  assertDedicatedTestDatabaseUrl(databaseUrl);
  await createTestDatabaseIfMissing(databaseUrl);
  await runDatabaseMigrations({
    databaseUrl,
    migrationsFolder: options.migrationsFolder ?? path.resolve(process.cwd(), "drizzle"),
  });

  const connection = createDatabaseConnection(databaseUrl, { max: 1 });

  try {
    await connection.sql.unsafe(
      `TRUNCATE TABLE ${resettableTables.map(quoteIdentifier).join(", ")} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await connection.close();
  }
}

export async function createTestDatabaseIfMissing(databaseUrl: string): Promise<void> {
  assertDedicatedTestDatabaseUrl(databaseUrl);

  const target = new URL(databaseUrl);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\/+/, ""));

  if (!databaseName) {
    throw new Error("TEST_DATABASE_URL must include a database name.");
  }

  const adminUrl = new URL(target);
  adminUrl.pathname = "/postgres";

  const admin = postgres(adminUrl.toString(), { max: 1 });

  try {
    const rows = await admin<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_database
        WHERE datname = ${databaseName}
      ) AS "exists"
    `;

    if (rows[0]?.exists) {
      return;
    }

    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export function assertDedicatedTestDatabaseUrl(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

  if (!databaseName.includes("test")) {
    throw new Error(
      `Refusing to reset non-test database "${databaseName}". Use TEST_DATABASE_URL.`,
    );
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
