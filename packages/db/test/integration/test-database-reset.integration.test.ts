import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseConnection } from "../../src/client.js";
import { runDatabaseMigrations } from "../../src/migrations.js";
import { resetTestDatabase } from "../../src/testing.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("deterministic test database reset", () => {
  beforeAll(async () => {
    await reset();
  });

  afterAll(async () => {
    await reset();
  });

  it("rebuilds clean data and migration state and restarts generated sequences", async () => {
    const temporaryMigrations = await createTemporaryMigrations(
      `CREATE TABLE reset_probe (id serial PRIMARY KEY, value text NOT NULL);`,
    );

    try {
      await resetTestDatabase({
        databaseUrl: requireDatabaseUrl(),
        migrationsFolder: temporaryMigrations,
      });
      await withDatabase(async (sql) => {
        await sql`INSERT INTO reset_probe (value) VALUES ('first'), ('second')`;
      });

      await resetTestDatabase({
        databaseUrl: requireDatabaseUrl(),
        migrationsFolder: temporaryMigrations,
      });

      const state = await withDatabase(async (sql) => {
        const [counts] = await sql<{ migrations: number; probes: number }[]>`
          SELECT
            (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations,
            (SELECT count(*)::int FROM reset_probe) AS probes
        `;
        const [inserted] = await sql<{ id: number }[]>`
          INSERT INTO reset_probe (value) VALUES ('after-reset') RETURNING id
        `;
        return { counts, inserted };
      });

      expect(state.counts).toEqual({ migrations: 3, probes: 0 });
      expect(state.inserted?.id).toBe(1);
    } finally {
      await rm(temporaryMigrations, { force: true, recursive: true });
      await reset();
    }
  });

  it("recovers schema drift by restoring the reviewed baseline exactly", async () => {
    await withDatabase(async (sql) => {
      await sql.unsafe("DROP TABLE products CASCADE");
      await sql.unsafe("CREATE TABLE reset_rogue_table (id integer PRIMARY KEY)");
    });

    await reset();

    const [state] = await withDatabase(
      (sql) => sql<{ foreign_key_exists: boolean; index_exists: boolean; rogue_exists: boolean }[]>`
        SELECT
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'sale_offers_product_id_products_id_fk'
          ) AS foreign_key_exists,
          to_regclass('public.products_sku_unique') IS NOT NULL AS index_exists,
          to_regclass('public.reset_rogue_table') IS NOT NULL AS rogue_exists
      `,
    );

    expect(state).toEqual({
      foreign_key_exists: true,
      index_exists: true,
      rogue_exists: false,
    });
  });

  it("fails closed on a connected-database identity mismatch before migration work", async () => {
    await withDatabase((sql) => sql.unsafe("CREATE TABLE identity_guard_probe (id integer)"));

    await expect(
      runDatabaseMigrations({
        databaseUrl: requireDatabaseUrl(),
        expectedDatabaseName: "checkout_surge_test_logger",
        migrationsFolder,
      }),
    ).rejects.toThrow("connected database identity did not match");

    const [probe] = await withDatabase(
      (sql) => sql<{ exists: boolean }[]>`
        SELECT to_regclass('public.identity_guard_probe') IS NOT NULL AS "exists"
      `,
    );
    expect(probe?.exists).toBe(true);
    await reset();
  });

  it("releases the serialization lock after a migration failure", async () => {
    const temporaryMigrations = await createTemporaryMigrations("THIS IS NOT VALID SQL;");
    try {
      await expect(
        resetTestDatabase({
          databaseUrl: requireDatabaseUrl(),
          migrationsFolder: temporaryMigrations,
        }),
      ).rejects.toThrow();
    } finally {
      await rm(temporaryMigrations, { force: true, recursive: true });
    }

    await expect(reset()).resolves.toBeUndefined();
  });

  it("serializes rebuilds with the administration-database advisory lock", async () => {
    const administrationUrl = new URL(requireDatabaseUrl());
    const databaseName = administrationUrl.pathname.slice(1);
    administrationUrl.pathname = "/postgres";
    const blocker = createDatabaseConnection(administrationUrl.toString(), { max: 1 });
    const lockKey = `checkout-surge-test-database-reset:${databaseName}`;

    try {
      await blocker.sql`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
      let completed = false;
      const pendingReset = reset().then(() => {
        completed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(completed).toBe(false);
      await blocker.sql`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
      await pendingReset;
    } finally {
      await blocker.close();
    }
  });
});

async function reset(): Promise<void> {
  await resetTestDatabase({ databaseUrl: requireDatabaseUrl(), migrationsFolder });
}

async function withDatabase<T>(
  action: (sql: ReturnType<typeof createDatabaseConnection>["sql"]) => Promise<T>,
): Promise<T> {
  const connection = createDatabaseConnection(requireDatabaseUrl(), { max: 1 });
  try {
    return await action(connection.sql);
  } finally {
    await connection.close();
  }
}

async function createTemporaryMigrations(sql: string): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "checkout-surge-migrations-"));
  await cp(migrationsFolder, folder, { recursive: true });
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: Array<{ idx: number; when: number; tag: string; breakpoints: boolean }>;
  };
  const last = journal.entries.at(-1);
  journal.entries.push({
    idx: (last?.idx ?? -1) + 1,
    when: (last?.when ?? Date.now()) + 1,
    tag: "9999_test_reset_probe",
    breakpoints: true,
  });
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  await writeFile(path.join(folder, "9999_test_reset_probe.sql"), sql);
  return folder;
}

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for reset integration tests.");
  }
  return databaseUrl;
}
