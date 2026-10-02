import { randomUUID } from "node:crypto";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { type CheckoutSurgeDatabase, createDatabaseConnection, type SqlClient } from "./client.js";
import { assertConnectedDatabaseIdentity } from "./database-identity.js";
import { resolveMigrationsFolder, runDatabaseMigrations } from "./migrations.js";
import { demoPresets, demoRunSaleContexts, demoRuns, saleOffers } from "./schema.js";
import {
  assertTestEnvironment,
  validateDedicatedTestDatabaseUrl,
} from "./test-environment-safety.js";

const advisoryLockNamespace = "checkout-surge-test-database-reset";

export interface ResetTestDatabaseOptions {
  databaseUrl?: string;
  migrationsFolder?: string;
}

export async function resetTestDatabase(options: ResetTestDatabaseOptions = {}): Promise<void> {
  const databaseUrl = requireTestDatabaseUrl(options.databaseUrl);
  const { databaseName, url } = validateDedicatedTestDatabaseUrl(databaseUrl);
  const migrationsFolder = resolveMigrationsFolder(options.migrationsFolder);
  const administrationUrl = new URL(url);
  administrationUrl.pathname = "/postgres";
  const administrationSql = postgres(administrationUrl.toString(), { max: 1 });

  try {
    await acquireResetLock(administrationSql, databaseName);
    await createTestDatabaseIfMissing(administrationSql, databaseName);

    const connection = createDatabaseConnection(databaseUrl, { max: 1 });
    try {
      await rebuildTestSchema(connection.sql, {
        databaseName,
        databaseUrl,
        migrationsFolder,
      });
    } finally {
      await connection.close();
    }
  } finally {
    await administrationSql.end({ timeout: 5 });
  }
}

export function requireTestDatabaseUrl(databaseUrl = process.env.TEST_DATABASE_URL): string {
  assertTestEnvironment("access the test database");
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for test database access.");
  }
  validateDedicatedTestDatabaseUrl(databaseUrl);
  return databaseUrl;
}

async function rebuildTestSchema(
  sql: SqlClient,
  options: { databaseName: string; databaseUrl: string; migrationsFolder: string },
): Promise<void> {
  await assertConnectedDatabaseIdentity(sql, options.databaseName);
  await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
  await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await sql.unsafe("CREATE SCHEMA public");

  await runDatabaseMigrations({
    databaseUrl: options.databaseUrl,
    expectedDatabaseName: options.databaseName,
    migrationsFolder: options.migrationsFolder,
  });
}

async function acquireResetLock(sql: SqlClient, databaseName: string): Promise<void> {
  const lockKey = `${advisoryLockNamespace}:${databaseName}`;
  await sql`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
}

async function createTestDatabaseIfMissing(sql: SqlClient, databaseName: string): Promise<void> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_database
      WHERE datname = ${databaseName}
    ) AS "exists"
  `;

  if (!rows[0]?.exists) {
    await sql.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Create the durable ownership and frozen configuration for purchase-boundary tests. */
export async function createPurchaseRunFixture(
  db: CheckoutSurgeDatabase,
  input: { runId: string; saleOfferId: string; status?: "active" | "draining" | "completed" },
): Promise<void> {
  const [offer] = await db
    .select({ stock: saleOffers.allocatedStock })
    .from(saleOffers)
    .where(eq(saleOffers.id, input.saleOfferId));
  if (!offer) throw new Error("Purchase fixture requires its existing sale offer.");
  const presetId = randomUUID();
  const configSnapshot = previewRunConfigSnapshotFixture();
  configSnapshot.inventoryConfig.startingStock = offer.stock;
  await db
    .insert(demoPresets)
    .values({
      id: presetId,
      slug: `purchase-test-${input.runId}`,
      visibility: "admin",
      isEditable: true,
      isCustom: true,
      display: {
        name: "Purchase test",
        description: "Run-owned purchase fixture",
        sortOrder: 1,
        outcomeFocus: [],
      },
      ...configSnapshot,
    })
    .onConflictDoNothing();
  await db
    .insert(demoRuns)
    .values({
      id: input.runId,
      correlationId: `run-${input.runId}`,
      presetId,
      presetName: "Purchase test",
      operatorMode: "admin",
      status: input.status ?? "active",
      trafficStatus:
        input.status === "draining" || input.status === "completed" ? "succeeded" : "active",
      configSnapshot,
      saleOfferId: input.saleOfferId,
    })
    .onConflictDoNothing({ target: demoRuns.id });
  await db
    .insert(demoRunSaleContexts)
    .values({ runId: input.runId, saleOfferId: input.saleOfferId })
    .onConflictDoNothing();
}
