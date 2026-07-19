import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseConnection } from "../../src/client.js";
import { acquireTestInfrastructureLock, resetTestDatabase } from "../../src/testing.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const databaseUrl = process.env.TEST_DATABASE_URL;
const fingerprintTable = "__test_schema_fingerprint";

describe.skipIf(!databaseUrl)("deterministic test database reset", () => {
  beforeAll(async () => {
    await reset();
  });

  afterAll(async () => {
    await reset();
  });

  it("dynamically truncates a newly migrated table, restarts identity, and preserves metadata", async () => {
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
        const [counts] = await sql<
          {
            fingerprints: number;
            migrations: number;
            probes: number;
          }[]
        >`
          SELECT
            (SELECT count(*)::int FROM ${sql(fingerprintTable)}) AS fingerprints,
            (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations,
            (SELECT count(*)::int FROM reset_probe) AS probes
        `;
        const [inserted] = await sql<{ id: number }[]>`
          INSERT INTO reset_probe (value) VALUES ('after-reset') RETURNING id
        `;
        return { counts, inserted };
      });

      expect(state.counts).toMatchObject({ fingerprints: 1, probes: 0 });
      expect(state.counts?.migrations).toBeGreaterThan(1);
      expect(state.inserted?.id).toBe(1);
    } finally {
      await rm(temporaryMigrations, { force: true, recursive: true });
      await reset();
    }
  });

  it.each([
    {
      damage: `DROP TABLE products CASCADE`,
      restored: `SELECT to_regclass('public.products') IS NOT NULL AS restored`,
      shape: "table",
    },
    {
      damage: `ALTER TABLE products ALTER COLUMN is_active DROP DEFAULT`,
      restored: `SELECT column_default = 'true' AS restored FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'is_active'`,
      shape: "column default",
    },
    {
      damage: `ALTER TABLE products DROP CONSTRAINT products_pkey CASCADE`,
      restored: `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_pkey') AS restored`,
      shape: "constraint",
    },
    {
      damage: `DROP INDEX products_sku_unique`,
      restored: `SELECT to_regclass('public.products_sku_unique') IS NOT NULL AS restored`,
      shape: "index",
    },
    {
      damage: `DROP TRIGGER products_set_updated_at ON products`,
      restored: `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'products_set_updated_at') AS restored`,
      shape: "trigger",
    },
    {
      damage: `CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`,
      restored: `SELECT pg_get_functiondef('set_updated_at()'::regprocedure) LIKE '%NEW."updated_at" = now()%' AS restored`,
      shape: "function",
    },
  ])("rebuilds after $shape drift with an unchanged journal", async ({ damage, restored }) => {
    await reset();
    await withDatabase((sql) => sql.unsafe(damage));
    await reset();
    const [result] = await withDatabase((sql) => sql.unsafe<{ restored: boolean }[]>(restored));
    expect(result?.restored).toBe(true);
  });

  it("rebuilds for missing, malformed, duplicate, and stale fingerprint markers", async () => {
    const corruptions = [
      `DROP TABLE ${fingerprintTable}`,
      `DELETE FROM ${fingerprintTable}`,
      `UPDATE ${fingerprintTable} SET fingerprint = 'malformed'`,
      `INSERT INTO ${fingerprintTable} SELECT * FROM ${fingerprintTable}`,
      `UPDATE ${fingerprintTable} SET fingerprint = repeat('0', 64)`,
    ];

    for (const corruption of corruptions) {
      await withDatabase((sql) => sql.unsafe(corruption));
      await reset();
      const [marker] = await withDatabase(
        (sql) => sql<{ count: number; valid: boolean }[]>`
          SELECT count(*)::int AS count,
            bool_and(fingerprint ~ '^[a-f0-9]{64}$') AS valid
          FROM ${sql(fingerprintTable)}
        `,
      );
      expect(marker).toEqual({ count: 1, valid: true });
    }
  });

  it("rebuilds when the applied Drizzle journal is altered, missing, or reordered", async () => {
    const corruptions = [
      `UPDATE drizzle.__drizzle_migrations SET hash = repeat('0', 64) WHERE id = (SELECT min(id) FROM drizzle.__drizzle_migrations)`,
      `DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`,
      `WITH first_two AS (
        SELECT id, row_number() OVER (ORDER BY id) AS position
        FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 2
      )
      UPDATE drizzle.__drizzle_migrations migration
      SET id = CASE
        WHEN first_two.position = 1 THEN (SELECT max(id) + 1 FROM drizzle.__drizzle_migrations)
        ELSE (SELECT id FROM first_two WHERE position = 1)
      END
      FROM first_two WHERE migration.id = first_two.id`,
    ];

    for (const corruption of corruptions) {
      await withDatabase((sql) => sql.unsafe(corruption));
      await reset();
      const [journal] = await withDatabase(
        (sql) =>
          sql<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
      );
      expect(journal?.count).toBe(15);
    }
  });

  it("does not record a fingerprint when migration rebuild fails and releases its locks", async () => {
    const temporaryMigrations = await createTemporaryMigrations("THIS IS NOT VALID SQL;");
    try {
      await expect(
        resetTestDatabase({
          databaseUrl: requireDatabaseUrl(),
          migrationsFolder: temporaryMigrations,
        }),
      ).rejects.toThrow();
      const [marker] = await withDatabase(
        (sql) => sql<{ exists: boolean }[]>`
          SELECT to_regclass('public.__test_schema_fingerprint') IS NOT NULL AS "exists"
        `,
      );
      expect(marker?.exists).toBe(false);
    } finally {
      await rm(temporaryMigrations, { force: true, recursive: true });
    }

    await expect(reset()).resolves.toBeUndefined();
  });

  it("serializes independent clients with a PostgreSQL advisory lock", async () => {
    const blocker = createDatabaseConnection(requireDatabaseUrl(), { max: 1 });
    const databaseName = new URL(requireDatabaseUrl()).pathname.slice(1);
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

  it("does not share filesystem locks between package databases", async () => {
    const loggerUrl = new URL(requireDatabaseUrl());
    loggerUrl.pathname = "/checkout_surge_test_logger";
    const [databaseLock, loggerLock] = await Promise.all([
      acquireTestInfrastructureLock({ databaseUrl: requireDatabaseUrl(), timeoutMs: 500 }),
      acquireTestInfrastructureLock({ databaseUrl: loggerUrl.toString(), timeoutMs: 500 }),
    ]);
    await Promise.all([databaseLock.release(), loggerLock.release()]);
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
