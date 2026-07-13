import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { createDatabaseConnection, type SqlClient } from "./client.js";
import { readExpectedDatabaseMigrations, runDatabaseMigrations } from "./migrations.js";
import {
  assertTestEnvironment,
  validateDedicatedTestDatabaseUrl,
} from "./test-environment-safety.js";

const fingerprintTable = "__test_schema_fingerprint";
const fingerprintMarkerId = "migrated-public-schema-v1";
const advisoryLockNamespace = "checkout-surge-test-database-reset";

export interface ResetTestDatabaseOptions {
  databaseUrl?: string;
  migrationsFolder?: string;
}

export interface TestInfrastructureLock {
  release(): Promise<void>;
}

export interface AcquireTestInfrastructureLockOptions {
  databaseUrl?: string;
  retryDelayMs?: number;
  staleLockMs?: number;
  timeoutMs?: number;
}

export async function resetTestDatabase(options: ResetTestDatabaseOptions = {}): Promise<void> {
  assertTestEnvironment("reset test database state");
  const databaseUrl = requireTestDatabaseUrl(options.databaseUrl ?? process.env.TEST_DATABASE_URL);
  const { databaseName } = validateDedicatedTestDatabaseUrl(databaseUrl);
  const migrationsFolder = options.migrationsFolder ?? path.resolve(process.cwd(), "drizzle");
  const lock = await acquireTestInfrastructureLock({ databaseUrl });

  try {
    await createTestDatabaseIfMissing(databaseUrl);
    const connection = createDatabaseConnection(databaseUrl, { max: 1 });

    try {
      await assertConnectedDatabaseIdentity(connection.sql, databaseName);
      await acquireDatabaseAdvisoryLock(connection.sql, databaseName);
      try {
        const journalMatches = await appliedMigrationsMatchJournal(
          connection.sql,
          migrationsFolder,
        );
        const fingerprintMatches = journalMatches
          ? await storedSchemaFingerprintMatches(connection.sql)
          : false;

        if (!journalMatches || !fingerprintMatches) {
          await rebuildTestSchema(connection.sql, {
            databaseName,
            databaseUrl,
            migrationsFolder,
          });
        } else {
          await truncatePublicTables(connection.sql);
        }
      } finally {
        await releaseDatabaseAdvisoryLock(connection.sql, databaseName);
      }
    } finally {
      await connection.close();
    }
  } finally {
    await lock.release();
  }
}

export async function acquireTestInfrastructureLock(
  options: AcquireTestInfrastructureLockOptions = {},
): Promise<TestInfrastructureLock> {
  assertTestEnvironment("acquire the test infrastructure lock");
  const databaseUrl = requireTestDatabaseUrl(options.databaseUrl ?? process.env.TEST_DATABASE_URL);
  validateDedicatedTestDatabaseUrl(databaseUrl);

  const retryDelayMs = options.retryDelayMs ?? 50;
  const staleLockMs = options.staleLockMs ?? 10 * 60_000;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const lockDir = path.join(os.tmpdir(), `checkout-surge-${databaseLockId(databaseUrl)}.lock`);

  while (true) {
    try {
      await mkdir(lockDir);
      let released = false;
      return {
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          await rm(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      await removeStaleLock(lockDir, staleLockMs);

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for test infrastructure lock ${lockDir}.`);
      }

      await sleep(retryDelayMs);
    }
  }
}

export async function createTestDatabaseIfMissing(databaseUrl: string): Promise<void> {
  assertTestEnvironment("create the test database");
  const { databaseName, url: target } = validateDedicatedTestDatabaseUrl(databaseUrl);
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

    if (!rows[0]?.exists) {
      await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

export function assertDedicatedTestDatabaseUrl(databaseUrl: string): void {
  assertTestEnvironment("access a destructive test database helper");
  validateDedicatedTestDatabaseUrl(databaseUrl);
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

  if (!(await appliedMigrationsMatchJournal(sql, options.migrationsFolder))) {
    throw new Error("Test database migration journal did not match after schema rebuild.");
  }

  await createFingerprintTable(sql);
  const fingerprint = await computeSchemaFingerprint(sql);
  await sql`
    INSERT INTO ${sql(fingerprintTable)} (marker_id, fingerprint)
    VALUES (${fingerprintMarkerId}, ${fingerprint})
  `;
}

async function appliedMigrationsMatchJournal(
  sql: SqlClient,
  migrationsFolder: string,
): Promise<boolean> {
  const expected = readExpectedDatabaseMigrations(migrationsFolder);
  const [table] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS "exists"
  `;
  if (!table?.exists) {
    return false;
  }

  const applied = await sql<{ created_at: string; hash: string }[]>`
    SELECT created_at::text, hash
    FROM drizzle.__drizzle_migrations
    ORDER BY id
  `;

  return (
    applied.length === expected.length &&
    applied.every(
      (migration, index) =>
        migration.hash === expected[index]?.hash &&
        Number(migration.created_at) === expected[index]?.createdAt,
    )
  );
}

async function storedSchemaFingerprintMatches(sql: SqlClient): Promise<boolean> {
  const [table] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${`public.${fingerprintTable}`}) IS NOT NULL AS "exists"
  `;
  if (!table?.exists) {
    return false;
  }

  const markers = await sql<{ fingerprint: string; marker_id: string }[]>`
    SELECT marker_id, fingerprint
    FROM ${sql(fingerprintTable)}
  `;
  if (
    markers.length !== 1 ||
    markers[0]?.marker_id !== fingerprintMarkerId ||
    !/^[a-f0-9]{64}$/.test(markers[0]?.fingerprint ?? "")
  ) {
    return false;
  }

  return markers[0].fingerprint === (await computeSchemaFingerprint(sql));
}

async function createFingerprintTable(sql: SqlClient): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE ${quoteIdentifier(fingerprintTable)} (
      marker_id text NOT NULL,
      fingerprint text NOT NULL
    )
  `);
}

async function computeSchemaFingerprint(sql: SqlClient): Promise<string> {
  const rows = await sql<{ canonical: string }[]>`
    SELECT canonical
    FROM (
      SELECT 'relation|' || jsonb_build_array(
        c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity
      )::text AS canonical
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')

      UNION ALL
      SELECT 'column|' || jsonb_build_array(
        c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod),
        a.attnotnull, a.attidentity, a.attgenerated, pg_get_expr(d.adbin, d.adrelid),
        coll.collname
      )::text
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN pg_collation coll ON coll.oid = a.attcollation AND a.attcollation <> 0
      WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped

      UNION ALL
      SELECT 'constraint|' || jsonb_build_array(
        c.relname, con.conname, con.contype, con.convalidated,
        pg_get_constraintdef(con.oid, true)
      )::text
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'

      UNION ALL
      SELECT 'index|' || jsonb_build_array(t.relname, i.relname, pg_get_indexdef(i.oid))::text
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'

      UNION ALL
      SELECT 'trigger|' || jsonb_build_array(
        c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid, true)
      )::text
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal

      UNION ALL
      SELECT 'routine|' || jsonb_build_array(
        p.proname, p.prokind, pg_get_function_identity_arguments(p.oid),
        p.proconfig, pg_get_functiondef(p.oid)
      )::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')

      UNION ALL
      SELECT 'type|' || jsonb_build_array(
        t.typname, t.typtype, t.typcategory, format_type(t.typbasetype, t.typtypmod),
        COALESCE((
          SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
          FROM pg_enum e WHERE e.enumtypid = t.oid
        ), '[]'::jsonb)
      )::text
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c')
        AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid)

      UNION ALL
      SELECT 'sequence|' || jsonb_build_array(
        c.relname, s.seqtypid::regtype::text, s.seqstart, s.seqincrement,
        s.seqmax, s.seqmin, s.seqcache, s.seqcycle, owned_table.relname, owned_column.attname
      )::text
      FROM pg_sequence s
      JOIN pg_class c ON c.oid = s.seqrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_depend dependency
        ON dependency.objid = c.oid AND dependency.deptype IN ('a', 'i')
      LEFT JOIN pg_class owned_table ON owned_table.oid = dependency.refobjid
      LEFT JOIN pg_attribute owned_column
        ON owned_column.attrelid = dependency.refobjid
        AND owned_column.attnum = dependency.refobjsubid
      WHERE n.nspname = 'public'

      UNION ALL
      SELECT 'view|' || jsonb_build_array(c.relname, pg_get_viewdef(c.oid, true))::text
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')

      UNION ALL
      SELECT 'policy|' || jsonb_build_array(
        schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      )::text
      FROM pg_policies
      WHERE schemaname = 'public'

      UNION ALL
      SELECT 'extension|' || jsonb_build_array(e.extname, e.extversion)::text
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE n.nspname = 'public'
    ) details
    ORDER BY canonical
  `;

  return createHash("sha256")
    .update(rows.map((row) => row.canonical).join("\n"))
    .digest("hex");
}

async function truncatePublicTables(sql: SqlClient): Promise<void> {
  const tables = await sql<{ table_name: string }[]>`
    SELECT tablename AS table_name
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> ${fingerprintTable}
    ORDER BY tablename
  `;
  if (tables.length === 0) {
    throw new Error("Refusing to truncate a test schema with no business tables.");
  }

  await sql.unsafe(
    `TRUNCATE TABLE ${tables.map((table) => quoteIdentifier(table.table_name)).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

async function assertConnectedDatabaseIdentity(
  sql: SqlClient,
  expectedDatabaseName: string,
): Promise<void> {
  const [identity] = await sql<{ database_name: string }[]>`
    SELECT current_database() AS database_name
  `;
  if (identity?.database_name !== expectedDatabaseName) {
    throw new Error("Refusing destructive SQL: connected database identity did not match target.");
  }
}

async function acquireDatabaseAdvisoryLock(sql: SqlClient, databaseName: string): Promise<void> {
  await sql`SELECT pg_advisory_lock(hashtextextended(${`${advisoryLockNamespace}:${databaseName}`}, 0))`;
}

async function releaseDatabaseAdvisoryLock(sql: SqlClient, databaseName: string): Promise<void> {
  await sql`SELECT pg_advisory_unlock(hashtextextended(${`${advisoryLockNamespace}:${databaseName}`}, 0))`;
}

function requireTestDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for destructive test database access.");
  }
  return databaseUrl;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseLockId(databaseUrl: string): string {
  const { databaseName } = validateDedicatedTestDatabaseUrl(databaseUrl);
  const safeName = databaseName.replace(/[^A-Za-z0-9_-]+/g, "_");
  const hash = createHash("sha256").update(databaseUrl).digest("hex").slice(0, 12);

  return `${safeName}-${hash}`;
}

async function removeStaleLock(lockDir: string, staleLockMs: number): Promise<void> {
  try {
    const stats = await stat(lockDir);
    if (Date.now() - stats.mtimeMs >= staleLockMs) {
      await rm(lockDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function isNotFoundError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
