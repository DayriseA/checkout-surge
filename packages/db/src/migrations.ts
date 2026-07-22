import { fileURLToPath } from "node:url";
import { publicRuntimePolicyPersistedSchema } from "@checkout-surge/contracts";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabaseConnection } from "./client.js";

export interface RunMigrationsOptions {
  databaseUrl: string;
  expectedDatabaseName?: string;
  migrationsFolder?: string;
}

export interface ExpectedDatabaseMigration {
  createdAt: number;
  hash: string;
}

const packageMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function resolveMigrationsFolder(migrationsFolder?: string): string {
  return migrationsFolder ?? packageMigrationsFolder;
}

export function readExpectedDatabaseMigrations(
  migrationsFolder: string,
): ExpectedDatabaseMigration[] {
  return readMigrationFiles({ migrationsFolder }).map((migration) => ({
    createdAt: migration.folderMillis,
    hash: migration.hash,
  }));
}

export async function runDatabaseMigrations(options: RunMigrationsOptions): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder(options.migrationsFolder);
  const connection = createDatabaseConnection(options.databaseUrl, { max: 1 });

  try {
    if (options.expectedDatabaseName) {
      const [identity] = await connection.sql<{ database_name: string }[]>`
        SELECT current_database() AS database_name
      `;
      if (identity?.database_name !== options.expectedDatabaseName) {
        throw new Error(
          `Refusing database migrations: connected database identity did not match the validated target.`,
        );
      }
    }
    await migrate(connection.db, { migrationsFolder });
    await validateMigratedActivePublicRuntimePolicy(connection.sql);
  } finally {
    await connection.close();
  }
}

async function validateMigratedActivePublicRuntimePolicy(
  sql: ReturnType<typeof createDatabaseConnection>["sql"],
): Promise<void> {
  const [row] = await sql<{ policy: unknown }[]>`
    SELECT policy
    FROM public_runtime_policies
    WHERE id = 'active'
    LIMIT 1
  `;
  if (!row) {
    return;
  }

  const parsed = publicRuntimePolicyPersistedSchema.safeParse(row.policy);
  if (parsed.success) {
    return;
  }

  const diagnostics = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "policy";
    const violationCode =
      "params" in issue &&
      issue.params &&
      typeof issue.params === "object" &&
      "violationCode" in issue.params &&
      typeof issue.params.violationCode === "string"
        ? ` (${issue.params.violationCode})`
        : "";
    return `${path}${violationCode}: ${issue.message}`;
  });

  throw new Error(
    `Active public runtime policy is invalid after database migration: ${diagnostics.join("; ")}`,
  );
}
