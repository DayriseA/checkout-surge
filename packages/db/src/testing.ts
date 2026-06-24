import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
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
  const databaseUrl = options.databaseUrl ?? process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required to reset test database state.");
  }

  assertDedicatedTestDatabaseUrl(databaseUrl);
  const lock = await acquireTestInfrastructureLock({ databaseUrl });

  try {
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
  } finally {
    await lock.release();
  }
}

export async function acquireTestInfrastructureLock(
  options: AcquireTestInfrastructureLockOptions = {},
): Promise<TestInfrastructureLock> {
  const databaseUrl = options.databaseUrl ?? process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required to acquire the test infrastructure lock.");
  }

  assertDedicatedTestDatabaseUrl(databaseUrl);

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

function databaseLockId(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
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
